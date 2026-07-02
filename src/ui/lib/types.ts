// Mirror of the records main.ts posts to the UI. Keep in sync with src/main.ts.

export type Origin = "local" | "library" | "unknown";

export interface InstanceRecord {
  componentName: string;
  componentKey: string | null;
  variant: string | null;
  masterKey: string | null;
  origin: Origin;
  libraryName: string | null;
  libraryKey: string | null;
  visible: boolean;
  directlyVisible: boolean;
  page: string;
  path: string;
  depth: number;
  nestedInsideInstance: boolean;
  nestedInsideLibraryInstance: boolean;
  inheritedFromParent: boolean;
  inSlot: boolean;
  isMaster: boolean;
  parentInstanceId: string | null;
  nodeId: string;
}

export interface DetachRecord {
  layerName: string;
  matchedComponentName: string;
  page: string;
  path: string;
  nodeId: string;
}

export interface ScanResult {
  type: "result";
  fileName: string;
  buildId?: string;
  instances: InstanceRecord[];
  detaches: DetachRecord[];
  aborted: boolean;
  stats?: {
    totalNodes?: number;
    instances?: number;
    uniqueLibraryMasters?: number;
    timings?: Record<string, number>;
  };
  diag?: unknown;
}

export interface ProgressMsg {
  type: "progress";
  phase: string;
  done: number;
  total: number;
  detail?: string;
}

export type IncomingMsg =
  | ScanResult
  | ProgressMsg
  | { type: "warn"; message: string }
  | { type: "error"; message: string }
  | { type: "focusResult"; ok: boolean; message?: string };

export type OutgoingMsg =
  | { type: "scan" }
  | { type: "cancel" }
  | { type: "close" }
  | { type: "focus"; nodeId: string };

export type ViewMode = "flat" | "tree";
export type SortKey = "name" | "source" | "count";
export type SortDir = -1 | 1;
