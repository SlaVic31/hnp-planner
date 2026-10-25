export interface OutlineDocRef {
  id: string;
  title: string;
  url: string;
  collectionId: string | null;
  snippet?: string;
}

export interface OutlineDoc extends OutlineDocRef {
  text: string;
  updatedAt?: string;
}

export interface OutlineCollection {
  id: string;
  name: string;
  url?: string;
}

export interface OutlineToolInfo {
  name: string;
  readOnlyHint: boolean | null;
  /** Czy aplikacja zezwala na wywołanie tego narzędzia. */
  allowed: boolean;
}

export interface OutlineStatus {
  mode: "demo" | "mcp";
  connected: boolean;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  tools: OutlineToolInfo[];
  /** Narzędzia zapisu wykryte na serwerze — zawsze blokowane przez aplikację. */
  blockedWriteTools: string[];
  missingCapabilities: string[];
}

/**
 * Źródło dokumentów Outline. Implementacje NIE egzekwują zakresu projektu —
 * robi to ScopedOutline, aby reguła była w jednym miejscu dla trybu demo i MCP.
 */
export interface OutlineSource {
  readonly mode: "demo" | "mcp";
  search(query: string, collectionId: string, limit: number): Promise<OutlineDocRef[]>;
  getDocument(id: string): Promise<OutlineDoc>;
  listCollections(): Promise<OutlineCollection[]>;
  status(): Promise<OutlineStatus>;
  close(): Promise<void>;
}
