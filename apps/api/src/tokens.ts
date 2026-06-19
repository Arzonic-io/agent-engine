/** DI tokens. Everything is injected by token so the smoke test can override providers. */
export const ENV = "ENV" as const;
export const MODEL = "MODEL" as const;
/** Per-role model overrides (the configurable team members). RoleModels from core. */
export const ROLE_MODELS = "ROLE_MODELS" as const;
export const CHECKPOINTER = "CHECKPOINTER" as const;
export const MEMORY = "MEMORY" as const;
export const BACKLOG = "BACKLOG" as const;
