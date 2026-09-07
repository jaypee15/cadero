// packages/protocol/src/events.ts
import { z } from "zod";

const metaSchema = z.object({
  session_id: z.string().min(1),
  timestamp: z.number().int().nonnegative().optional(),
});

export const TerminalDataSchema = z.object({
  event: z.literal("TERMINAL_DATA"),
  meta: metaSchema,
  payload: z.object({ chunk: z.string() }),
});

export const InterceptRequiredSchema = z.object({
  event: z.literal("INTERCEPT_REQUIRED"),
  meta: metaSchema,
  payload: z.object({
    agent: z.enum(["claude", "opencode"]),
    reason: z.string().min(1),
    command: z.string(),
  }),
});

export const ResolveInterceptSchema = z.object({
  event: z.literal("RESOLVE_INTERCEPT"),
  meta: metaSchema,
  payload: z.object({
    decision: z.enum(["APPROVE", "DENY"]),
    input_payload: z.string().nullable(),
  }),
});

export const ExecuteAgentPromptSchema = z.object({
  event: z.literal("EXECUTE_AGENT_PROMPT"),
  meta: metaSchema,
  payload: z.object({ prompt: z.string().min(1).max(20000) }),
});

export const WireEventSchema = z.discriminatedUnion("event", [
  TerminalDataSchema,
  InterceptRequiredSchema,
  ResolveInterceptSchema,
  ExecuteAgentPromptSchema,
]);

export type TerminalData = z.infer<typeof TerminalDataSchema>;
export type InterceptRequired = z.infer<typeof InterceptRequiredSchema>;
export type ResolveIntercept = z.infer<typeof ResolveInterceptSchema>;
export type ExecuteAgentPrompt = z.infer<typeof ExecuteAgentPromptSchema>;
export type WireEvent = z.infer<typeof WireEventSchema>;
