/*
 * Data layer for the F1 Standings extension.
 *
 * Standings come from the free Jolpica F1 API (an Ergast-compatible mirror):
 * https://api.jolpi.ca/ergast/f1/current/driverStandings.json
 *
 * The last successful response is cached on disk so the popup still has
 * something to show when the network is unavailable.
 */

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const API_URL =
    'https://api.jolpi.ca/ergast/f1/current/driverStandings.json?limit=100';
const CACHE_VERSION = 1;
const REQUEST_TIMEOUT_SECONDS = 20;
const USER_AGENT = 'gnome-shell-f1-standings/1.0';

/* 2026 grid colours, keyed by the API's constructorId. */
const TEAM_COLORS = {
    mercedes: '#27f4d2',
    ferrari: '#e8002d',
    red_bull: '#3671c6',
    mclaren: '#ff8000',
    aston_martin: '#229971',
    alpine: '#ff87bc',
    williams: '#64c4ff',
    rb: '#6692ff',
    racing_bulls: '#6692ff',
    sauber: '#52e252',
    audi: '#f50537',
    cadillac: '#d4af37',
    haas: '#b6babd',
};

/* Used when the API reports a team we do not know yet. */
const FALLBACK_COLORS = [
    '#e10600', '#00d2be', '#ff8700', '#005aff', '#b6babd', '#9b0000',
    '#f596c8', '#0082fa', '#2b4562', '#c8c8c8',
];

/**
 * @param {string} constructorId
 * @returns {string} a CSS colour for the team
 */
export function teamColor(constructorId) {
    if (TEAM_COLORS[constructorId])
        return TEAM_COLORS[constructorId];

    let hash = 0;
    for (const char of String(constructorId ?? ''))
        hash = (hash * 31 + char.codePointAt(0)) >>> 0;

    return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

/**
 * @param {number} points
 * @returns {string} points formatted the way F1 does it (half points included)
 */
export function formatPoints(points) {
    if (!Number.isFinite(points))
        return '–';
    return Number.isInteger(points) ? String(points) : points.toFixed(1);
}

/**
 * Turn a driverStandings API payload into the shape the UI wants.
 *
 * @param {object} payload parsed JSON from the API
 * @returns {{season: string, round: number, drivers: object[]}}
 */
export function parseStandings(payload) {
    const table = payload?.MRData?.StandingsTable;
    const list = table?.StandingsLists?.[0];

    if (!list || !Array.isArray(list.DriverStandings))
        throw new Error('Unexpected response from the standings service');

    const drivers = list.DriverStandings.map(entry => {
        const driver = entry.Driver ?? {};
        const constructor = entry.Constructors?.[0] ?? {};
        const name = [driver.givenName, driver.familyName]
            .filter(part => !!part)
            .join(' ');

        return {
            position: Number.parseInt(entry.position, 10),
            code: driver.code ?? '',
            name: name || driver.driverId || 'Unknown driver',
            team: constructor.name ?? 'Unknown team',
            teamId: constructor.constructorId ?? '',
            points: Number.parseFloat(entry.points),
            wins: Number.parseInt(entry.wins ?? '0', 10) || 0,
        };
    });

    drivers.sort((a, b) => a.position - b.position);

    return {
        season: table.season ?? list.season ?? '',
        round: Number.parseInt(list.round, 10) || 0,
        drivers,
    };
}

export class StandingsService {
    constructor() {
        this._session = new Soup.Session({
            timeout: REQUEST_TIMEOUT_SECONDS,
        });
        this._cachePath = GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'f1-standings', 'standings.json',
        ]);
    }

    /**
     * Download the current standings and cache them.
     *
     * @returns {Promise<{season: string, round: number, drivers: object[], fetchedAt: number}>}
     */
    async fetch() {
        const message = Soup.Message.new('GET', API_URL);
        message.request_headers.append('User-Agent', USER_AGENT);
        message.request_headers.append('Accept', 'application/json');

        /* GJS does not auto-promisify this particular async method, so the
         * callback is wrapped by hand. */
        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message, Soup.MessagePriority.NORMAL, null, (session, result) => {
                    try {
                        resolve(session.send_and_read_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
        });

        if (message.status_code !== Soup.Status.OK)
            throw new Error(`Standings request failed (HTTP ${message.status_code})`);

        let payload;
        try {
            const text = new TextDecoder().decode(bytes.get_data());
            payload = JSON.parse(text);
        } catch {
            throw new Error('The standings service returned invalid data');
        }

        const standings = parseStandings(payload);
        standings.fetchedAt = Math.floor(Date.now() / 1000);
        this.saveCache(standings);
        return standings;
    }

    /**
     * @returns {object|null} the previously cached standings, if any
     */
    loadCache() {
        try {
            const [ok, contents] = GLib.file_get_contents(this._cachePath);
            if (!ok)
                return null;

            const cached = JSON.parse(new TextDecoder().decode(contents));
            if (cached?.version !== CACHE_VERSION || !Array.isArray(cached.drivers))
                return null;

            return cached;
        } catch {
            return null;
        }
    }

    /**
     * @param {object} standings
     */
    saveCache(standings) {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._cachePath), 0o755);
            GLib.file_set_contents(this._cachePath, JSON.stringify({
                version: CACHE_VERSION,
                ...standings,
            }));
        } catch (error) {
            console.warn(`F1 Standings: could not write cache: ${error.message}`);
        }
    }

    destroy() {
        this._session.abort();
    }
}
