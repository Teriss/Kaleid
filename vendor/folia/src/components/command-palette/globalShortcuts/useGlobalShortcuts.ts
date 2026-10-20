import { useEffect, useMemo, useRef, useState } from 'react';
import { useInteractionSettingsStore } from '../../../stores/useInteractionSettingsStore';
import { commandForGlobalShortcut, PORTAL_GLOBAL_SHORTCUTS, resolveActiveGlobalShortcuts, type ActiveGlobalShortcut } from './globalShortcutRules';
import { useGlobalShortcutStatusStore, type GlobalShortcutBackend } from './globalShortcutStatusStore';

// src/components/command-palette/globalShortcuts/useGlobalShortcuts.ts
// Keeps the main process's registered shortcuts in step with the settings, and runs the bound
// command when one is pressed. Natively that is the listener's five bindings; on the Wayland portal
// it is the fixed table of every playback command, and only once the listener has asked for it.
// Desktop only: on web `window.electron` is absent and this does nothing.

const NO_SHORTCUTS: ReadonlyArray<ActiveGlobalShortcut> = [];

export const useGlobalShortcuts = (runCommand: (commandId: string) => void) => {
    const bindings = useInteractionSettingsStore(state => state.globalShortcutBindings);
    const portalEnabled = useInteractionSettingsStore(state => state.globalShortcutPortalEnabled);
    // Asked before anything is registered: on the portal the listener's bindings must not go out.
    const [backend, setBackend] = useState<GlobalShortcutBackend | null>(null);
    useEffect(() => {
        let gone = false;
        window.electron?.getGlobalShortcutBackend?.()
            .then((answer) => {
                if (!gone) {
                    setBackend(answer);
                    useGlobalShortcutStatusStore.getState().setBackend(answer);
                }
            })
            .catch((error) => {
                console.warn('[GlobalShortcut] backend query failed', error);
            });
        return () => {
            gone = true;
        };
    }, []);

    const active = useMemo(() => {
        if (backend === 'portal') {
            return portalEnabled ? PORTAL_GLOBAL_SHORTCUTS : NO_SHORTCUTS;
        }
        return resolveActiveGlobalShortcuts(bindings);
    }, [backend, bindings, portalEnabled]);
    // A press is resolved against the bindings of that moment, so changing only the command of a
    // slot takes effect without registering the key again.
    const activeRef = useRef(active);
    activeRef.current = active;
    const runCommandRef = useRef(runCommand);
    runCommandRef.current = runCommand;

    const accelerators = active.map(shortcut => shortcut.accelerator).join(',');
    useEffect(() => {
        const setGlobalShortcuts = window.electron?.setGlobalShortcuts;
        if (!setGlobalShortcuts || !backend) {
            return;
        }
        let superseded = false;
        setGlobalShortcuts(accelerators ? accelerators.split(',') : [])
            .then((answer) => {
                if (!superseded) {
                    useGlobalShortcutStatusStore.getState().publish(answer);
                }
            })
            .catch((error) => {
                console.warn('[GlobalShortcut] registering failed', error);
            });
        return () => {
            superseded = true;
        };
    }, [accelerators, backend]);

    useEffect(() => window.electron?.onGlobalShortcut?.((accelerator) => {
        const commandId = commandForGlobalShortcut(activeRef.current, accelerator);
        if (commandId) {
            runCommandRef.current(commandId);
        }
    }), []);
};
