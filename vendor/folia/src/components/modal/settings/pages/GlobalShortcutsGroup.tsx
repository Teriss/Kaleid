import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { COMMAND_PALETTE_COMMANDS } from '../../../command-palette/commandRegistry';
import { getCommandTitle } from '../../../command-palette/commandText';
import {
    GLOBAL_SHORTCUT_COMMAND_IDS,
    GLOBAL_SHORTCUT_MODIFIER_LABELS,
    PORTAL_GLOBAL_SHORTCUTS,
    readGlobalShortcutKey,
    refuseGlobalShortcutKey,
    toGlobalShortcutAccelerator,
    type GlobalShortcutKeyRefusal,
} from '../../../command-palette/globalShortcuts/globalShortcutRules';
import { useGlobalShortcutStatusStore } from '../../../command-palette/globalShortcuts/globalShortcutStatusStore';
import { useInteractionSettingsStore } from '../../../../stores/useInteractionSettingsStore';
import { Button, Group, KeyCapture, Keys, Row, Select, Status, option, type SettingsGroupDef } from '../kit';

// src/components/modal/settings/pages/GlobalShortcutsGroup.tsx
// The 全局快捷键 group of the 快捷操作 page: five system-wide shortcuts of the desktop app, each a key
// pressed with the fixed Ctrl+Alt+Shift and one playback command. Which keys and commands are
// allowed is globalShortcutRules' answer; whether the system took a key is the main process's,
// read from the status store. On native Wayland the keys picked here would do nothing, so the rows
// give way to one button that hands every playback command to the desktop's shortcut portal, and
// the note lists which suggested key is which command, for the desktop's own list.

export const GLOBAL_SHORTCUTS: SettingsGroupDef = { id: 'globalShortcuts', titleKey: 'options.settingsHeadingGlobalShortcuts', electronOnly: true };

const O = {
    slots: option(GLOBAL_SHORTCUTS, 'globalShortcutSlots', 'options.globalShortcuts'),
};

export const GLOBAL_SHORTCUTS_OPTIONS = Object.values(O);

const REFUSAL_KEYS: Record<GlobalShortcutKeyRefusal, string> = {
    'not-letter-or-digit': 'options.globalShortcutLettersAndDigits',
    reserved: 'options.globalShortcutReserved',
    duplicate: 'options.globalShortcutDuplicate',
};

export const GlobalShortcutsGroup: React.FC = () => {
    const { t } = useTranslation();
    const { bindings, setBinding, portalEnabled, setPortalEnabled } = useInteractionSettingsStore(useShallow(state => ({
        bindings: state.globalShortcutBindings,
        setBinding: state.setGlobalShortcutBinding,
        portalEnabled: state.globalShortcutPortalEnabled,
        setPortalEnabled: state.setGlobalShortcutPortalEnabled,
    })));
    const { backend, refused } = useGlobalShortcutStatusStore(useShallow(state => ({
        backend: state.backend,
        refused: state.refused,
    })));
    const onPortal = backend === 'portal';

    const commandTitle = useCallback((id: string) => {
        const command = COMMAND_PALETTE_COMMANDS.find(entry => entry.id === id);
        return command ? getCommandTitle(command, t) : id;
    }, [t]);
    const commandOptions = useMemo(() => [
        { value: '', label: t('options.globalShortcutNoCommand') },
        ...GLOBAL_SHORTCUT_COMMAND_IDS.map(id => ({ value: id, label: commandTitle(id) })),
    ], [commandTitle, t]);

    // One validator per slot, so a key is refused against the other four.
    const validators = useMemo(() => bindings.map((_, slot) => (key: string): string | null => {
        const refusal = refuseGlobalShortcutKey(key, slot, bindings);
        return refusal ? t(REFUSAL_KEYS[refusal]) : null;
    }), [bindings, t]);
    const readKey = useCallback((event: KeyboardEvent) => readGlobalShortcutKey(event), []);

    if (onPortal) {
        return (
            <Group def={GLOBAL_SHORTCUTS}>
                <Row
                    option={O.slots}
                    hint={t(portalEnabled ? 'options.globalShortcutPortalRegistered' : 'options.globalShortcutsPortalDesc')}
                    note={(
                        <>
                            <p>{t('options.globalShortcutsPortalNote')}</p>
                            <ul className="mt-2 space-y-1">
                                {PORTAL_GLOBAL_SHORTCUTS.map(shortcut => (
                                    <li key={shortcut.accelerator} className="flex items-center gap-2">
                                        <Keys keys={[...GLOBAL_SHORTCUT_MODIFIER_LABELS, shortcut.accelerator.slice(-1)]} />
                                        <span>{commandTitle(shortcut.commandId)}</span>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                >
                    <Button variant={portalEnabled ? 'quiet' : 'primary'} onClick={() => setPortalEnabled(!portalEnabled)}>
                        {t(portalEnabled ? 'options.globalShortcutPortalUnregister' : 'options.globalShortcutPortalRegister')}
                    </Button>
                </Row>
            </Group>
        );
    }

    return (
        <Group def={GLOBAL_SHORTCUTS}>
            <Row option={O.slots} hint={t('options.globalShortcutsDesc')} note={t('options.globalShortcutsNote')} />
            {bindings.map((binding, slot) => {
                const isRefused = Boolean(binding.key && binding.commandId)
                    && refused.includes(toGlobalShortcutAccelerator(binding.key ?? ''));
                return (
                    <Row
                        key={slot}
                        sub
                        label={t('options.globalShortcutSlot', { index: slot + 1 })}
                        below={isRefused ? <Status tone="error">{t('options.globalShortcutTakenBySystem')}</Status> : undefined}
                    >
                        <KeyCapture
                            value={binding.key}
                            onChange={key => setBinding(slot, { key })}
                            validate={validators[slot]}
                            prefix={GLOBAL_SHORTCUT_MODIFIER_LABELS}
                            readKey={readKey}
                        />
                        <Select
                            name={t('options.globalShortcutCommand', { index: slot + 1 })}
                            value={binding.commandId ?? ''}
                            options={commandOptions}
                            onChange={value => setBinding(slot, { commandId: value || null })}
                        />
                    </Row>
                );
            })}
        </Group>
    );
};

export default GlobalShortcutsGroup;
