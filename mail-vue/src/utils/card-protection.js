import { useSettingStore } from '@/store/setting.js';

export function acceptProtectionState(version, enabled) {
  version = Number(version);
  if (!Number.isSafeInteger(version) || version < 1) return false;
  const store = useSettingStore();
  const current = Number(store.settings.cardProtectionVersion || 0);
  if (version < current) return false;
  store.settings.cardProtectionEnabled = !!enabled;
  store.settings.cardProtectionVersion = version;
  // The only cross-tab value stored is the policy revision, never email content.
  localStorage.setItem('card-protection-version', String(version));
  return true;
}
