// GNOME Shell extension shipped with Overlay Assistant: keeps the overlay out of screenshots.
//
// Linux can't exclude a window from a capture, but GNOME Shell draws every screenshot itself
// (the Print key, the screenshot portal, gnome-screenshot: all end in Shell.Screenshot). While one
// of those captures is being painted, this makes the overlay's windows fully transparent, so they
// are left out of the picture; they are back on screen once the capture is done. Nothing else is
// touched, and only windows whose WM_CLASS is overlay-assistant are affected.
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const WM_CLASS = 'overlay-assistant';
// Captures of the whole stage or an area. screenshot_window paints one window on its own and is left alone.
const CAPTURES = ['screenshot', 'screenshot_area', 'screenshot_stage_to_content'];

function overlayActors() {
    return global.get_window_actors().filter(actor => {
        const win = actor.meta_window;
        return win && (win.get_wm_class() ?? '').toLowerCase() === WM_CLASS;
    });
}

export default class OverlayScreenshotHide extends Extension {
    enable() {
        this._originals = new Map();
        for (const name of CAPTURES) {
            const original = Shell.Screenshot.prototype[name];
            if (typeof original !== 'function')
                continue;
            this._originals.set(name, original);
            Shell.Screenshot.prototype[name] = function (...args) {
                const hidden = overlayActors().map(actor => [actor, actor.opacity]);
                for (const [actor] of hidden)
                    actor.opacity = 0;
                const restore = () => {
                    for (const [actor, opacity] of hidden)
                        actor.opacity = opacity;
                };
                // Shell code uses the promise form; a caller passing a callback gets it wrapped instead.
                const last = args.length - 1;
                if (typeof args[last] === 'function') {
                    const callback = args[last];
                    args[last] = (...cbArgs) => {
                        restore();
                        return callback(...cbArgs);
                    };
                    return original.apply(this, args);
                }
                let result;
                try {
                    result = original.apply(this, args);
                } catch (e) {
                    restore();
                    throw e;
                }
                if (result && typeof result.then === 'function')
                    return result.then(value => (restore(), value), error => (restore(), Promise.reject(error)));
                restore();
                return result;
            };
        }
    }

    disable() {
        for (const [name, original] of this._originals ?? [])
            Shell.Screenshot.prototype[name] = original;
        this._originals = null;
    }
}
