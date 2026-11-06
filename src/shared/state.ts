import type { Settings } from './settings';
import type { CloudMeta, LocalStatus } from './types';
import type { UsageRecord } from './usage-types';

export interface PermissionState {
  allSites: boolean;
  origins: string[];
}

export interface RuntimeState {
  settings: Settings;
  permission: PermissionState;
  local: LocalStatus;
  cloud: CloudMeta;
  usage: UsageRecord;
  fakeAvailable: boolean;
}
