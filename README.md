# F1 Standings (GNOME Shell extension)

Puts the official Formula 1 logo (white) on the left side of the top bar.
Click it for a popup with the live driver championship standings: position,
team colour, driver, team, wins and points.

The popup is capped at about a quarter of the screen height; the header and
footer stay put while the driver list scrolls.

> The F1 logo is a trademark of Formula One Licensing BV. It is included here
> for personal, non-commercial identification only.

- Data: [Jolpica F1 API](https://api.jolpi.ca/ergast/f1/current/driverStandings.json)
  (Ergast-compatible, no API key needed).
- Refreshes every 15 minutes in the background, and on open if the data is
  more than 5 minutes old.
- The last good response is cached in
  `~/.cache/f1-standings/standings.json`, so the popup still works offline.

## Install

Requires GNOME Shell 45–51 (tested on 50).

```sh
git clone https://github.com/SyncodeX7/gnome-f1-standings.git \
  ~/.local/share/gnome-shell/extensions/f1-standings@aditya
gnome-extensions enable f1-standings@aditya
```

The folder name must stay `f1-standings@aditya` to match the UUID in
`metadata.json`.

If the icon does not appear immediately on Wayland, log out and back in (the
shell cannot be restarted on Wayland).

## Uninstall

```sh
gnome-extensions disable f1-standings@aditya
rm -rf ~/.local/share/gnome-shell/extensions/f1-standings@aditya
```

The cached standings file can be removed from `~/.cache/f1-standings/`.

## Tweaking

Refresh intervals live at the top of `extension.js`
(`REFRESH_INTERVAL_SECONDS`, `REFRESH_IF_OLDER_SECONDS`), as does the popup
height (`POPUP_HEIGHT_FRACTION`, currently a quarter of the work area). Team
colours are in `TEAM_COLORS` in `standings.js`.

After editing CSS, reload with:

```sh
gnome-extensions disable f1-standings@aditya
gnome-extensions enable f1-standings@aditya
```

JavaScript is imported only once per shell session, so JS changes need a
logout/login on Wayland (or a shell restart on X11).
