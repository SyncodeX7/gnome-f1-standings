// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 SyncodeX7

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {StandingsService, teamColor, formatPoints} from './standings.js';

/* Poll in the background this often, even when the menu is never opened. */
const REFRESH_INTERVAL_SECONDS = 15 * 60;
/* Refresh on open when the data is older than this. */
const REFRESH_IF_OLDER_SECONDS = 5 * 60;

/* The popup takes this fraction of the monitor's work area, then scrolls. */
const POPUP_HEIGHT_FRACTION = 0.25;
const MIN_POPUP_HEIGHT = 220;

const F1Indicator = GObject.registerClass(
class F1Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'F1 Standings', false);

        this._extension = extension;
        this._service = new StandingsService();
        this._standings = null;
        this._fetching = false;
        this._offline = false;
        this._destroyed = false;

        this._gicon = new Gio.FileIcon({
            file: extension.dir.get_child('icons').get_child('f1.svg'),
        });

        this.add_child(new St.Icon({
            gicon: this._gicon,
            icon_size: 48,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._buildMenu();

        this._menuOpenId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._onMenuOpened();
        });

        this._showCachedOrLoad();

        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL_SECONDS, () => {
                this._fetch({quiet: true});
                return GLib.SOURCE_CONTINUE;
            });
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('f1-menu');

        /* One menu item holds the whole card: fixed header, scrolling list,
         * fixed footer. */
        this._popupItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'f1-popup-item',
        });
        this.menu.addMenuItem(this._popupItem);

        this._container = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'f1-popup',
        });
        this._popupItem.add_child(this._container);

        /* Header */
        const headerBox = new St.BoxLayout({
            x_expand: true,
            style_class: 'f1-header',
        });
        headerBox.add_child(new St.Icon({
            gicon: this._gicon,
            icon_size: 40,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const titles = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'f1-header-titles',
        });
        this._titleLabel = new St.Label({
            text: 'DRIVER STANDINGS',
            style_class: 'f1-title',
        });
        this._subtitleLabel = new St.Label({
            text: 'Loading…',
            style_class: 'f1-subtitle',
            opacity: 160,
        });
        titles.add_child(this._titleLabel);
        titles.add_child(this._subtitleLabel);
        headerBox.add_child(titles);
        this._container.add_child(headerBox);

        /* Column labels (fixed) */
        this._columnsBox = this._buildColumns();
        this._columnsBox.visible = false;
        this._container.add_child(this._columnsBox);

        /* Driver list (scrolls) */
        this._listBox = new St.BoxLayout({
            vertical: true,
            style_class: 'f1-list',
        });
        this._scrollView = new St.ScrollView({
            style_class: 'f1-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            y_expand: true,
        });
        this._scrollView.add_child(this._listBox);
        this._container.add_child(this._scrollView);

        /* Footer (fixed) */
        this._footerButton = new St.Button({
            x_expand: true,
            can_focus: true,
            style_class: 'f1-footer',
        });
        const footerBox = new St.BoxLayout({
            x_expand: true,
            style_class: 'f1-footer-box',
        });
        this._updatedLabel = new St.Label({
            text: '',
            x_expand: true,
            style_class: 'f1-updated',
            opacity: 160,
        });
        footerBox.add_child(this._updatedLabel);
        footerBox.add_child(new St.Label({
            text: 'Refresh',
            style_class: 'f1-refresh',
        }));
        this._footerButton.set_child(footerBox);
        this._footerButton.connect('clicked', () => this._fetch());
        this._container.add_child(this._footerButton);

        this._applyPopupHeight();
        this._showMessage('Loading standings…');
    }

    _buildColumns() {
        const box = new St.BoxLayout({
            x_expand: true,
            style_class: 'f1-columns',
        });
        box.add_child(new St.Label({
            text: 'POS',
            style_class: 'f1-col-pos',
            opacity: 140,
        }));
        box.add_child(new St.Widget({
            style_class: 'f1-col-spacer',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            text: 'DRIVER',
            x_expand: true,
            style_class: 'f1-col-driver',
            opacity: 140,
        }));
        box.add_child(new St.Label({
            text: 'PTS',
            x_align: Clutter.ActorAlign.END,
            style_class: 'f1-col-pts',
            opacity: 140,
        }));
        return box;
    }

    _applyPopupHeight() {
        const index = Main.layoutManager.primaryIndex;
        const workArea = index >= 0
            ? Main.layoutManager.getWorkAreaForMonitor(index)
            : null;
        const screenHeight = workArea ? workArea.height : 1080;

        this._container.set_height(Math.max(
            MIN_POPUP_HEIGHT,
            Math.round(screenHeight * POPUP_HEIGHT_FRACTION)));
    }

    _onMenuOpened() {
        this._applyPopupHeight();

        if (this._scrollView.vadjustment)
            this._scrollView.vadjustment.value = 0;

        const age = this._standings
            ? Math.floor(Date.now() / 1000) - this._standings.fetchedAt
            : Infinity;

        if (age > REFRESH_IF_OLDER_SECONDS)
            this._fetch({quiet: true});
    }

    _showCachedOrLoad() {
        const cached = this._service.loadCache();
        if (cached) {
            this._standings = cached;
            this._render();
        }

        this._fetch({quiet: !!cached});
    }

    async _fetch({quiet = false} = {}) {
        if (this._fetching || this._destroyed)
            return;

        this._fetching = true;
        if (!quiet)
            this._updateFooter();

        try {
            const standings = await this._service.fetch();
            if (this._destroyed)
                return;

            this._standings = standings;
            this._offline = false;
            this._render();
        } catch (error) {
            if (this._destroyed)
                return;

            console.warn(`F1 Standings: ${error.message}`);
            this._offline = true;

            if (this._standings)
                this._updateFooter();
            else
                this._showError(error.message);
        } finally {
            if (!this._destroyed) {
                this._fetching = false;
                this._updateFooter();
            }
        }
    }

    _render() {
        const standings = this._standings;
        if (!standings)
            return;

        this._subtitleLabel.set_text(
            `${standings.season} Season · After Round ${standings.round}`);

        this._columnsBox.visible = true;
        this._listBox.destroy_all_children();

        for (const driver of standings.drivers)
            this._listBox.add_child(this._driverRow(driver));

        this._updateFooter();
    }

    _driverRow(driver) {
        const isLeader = driver.position === 1;

        const box = new St.BoxLayout({
            x_expand: true,
            style_class: isLeader ? 'f1-row f1-row-leader' : 'f1-row',
        });

        box.add_child(new St.Label({
            text: String(driver.position),
            style_class: isLeader ? 'f1-pos f1-pos-leader' : 'f1-pos',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        box.add_child(new St.Widget({
            style_class: 'f1-team-bar',
            style: `background-color: ${teamColor(driver.teamId)};`,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'f1-driver-text',
        });
        textBox.add_child(new St.Label({
            text: driver.name,
            style_class: 'f1-driver-name',
        }));

        let teamText = driver.team;
        if (driver.wins > 0) {
            teamText += ` · ${driver.wins} ${driver.wins === 1 ? 'win' : 'wins'}`;
        }
        textBox.add_child(new St.Label({
            text: teamText,
            style_class: 'f1-team-name',
            opacity: 150,
        }));
        box.add_child(textBox);

        box.add_child(new St.Label({
            text: formatPoints(driver.points),
            style_class: isLeader ? 'f1-points f1-points-leader' : 'f1-points',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        return box;
    }

    _showMessage(title, detail = null) {
        this._columnsBox.visible = false;
        this._listBox.destroy_all_children();

        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'f1-message',
        });
        box.add_child(new St.Label({
            text: title,
            x_align: Clutter.ActorAlign.CENTER,
            style_class: 'f1-message-title',
        }));

        if (detail) {
            box.add_child(new St.Label({
                text: detail,
                x_align: Clutter.ActorAlign.CENTER,
                style_class: 'f1-message-detail',
                opacity: 160,
            }));
        }

        this._listBox.add_child(box);
    }

    _showError(message) {
        this._subtitleLabel.set_text('Unable to load standings');

        let detail = message || 'Check your internet connection.';
        if (detail.length > 90)
            detail = `${detail.slice(0, 87)}…`;

        this._showMessage('Could not load standings', detail);
        this._updatedLabel.set_text('Not updated');
    }

    _updateFooter() {
        if (!this._standings) {
            this._updatedLabel.set_text(this._offline ? 'Not updated' : '');
            return;
        }

        const when = this._relativeTime(this._standings.fetchedAt);
        if (this._offline)
            this._updatedLabel.set_text(`Offline · cached ${when}`);
        else if (this._fetching)
            this._updatedLabel.set_text('Updating…');
        else
            this._updatedLabel.set_text(`Updated ${when}`);
    }

    _relativeTime(timestamp) {
        if (!timestamp)
            return 'just now';

        const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
        if (seconds < 60)
            return 'just now';

        const minutes = Math.floor(seconds / 60);
        if (minutes < 60)
            return `${minutes} min ago`;

        const hours = Math.floor(minutes / 60);
        if (hours < 24)
            return `${hours} h ago`;

        const days = Math.floor(hours / 24);
        return `${days} d ago`;
    }

    destroy() {
        this._destroyed = true;

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        if (this._menuOpenId) {
            this.menu.disconnect(this._menuOpenId);
            this._menuOpenId = 0;
        }

        this._service.destroy();
        super.destroy();
    }
});

export default class F1StandingsExtension extends Extension {
    enable() {
        this._indicator = new F1Indicator(this);
        Main.panel.addToStatusArea('f1-standings', this._indicator, 1, 'left');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
