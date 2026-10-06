import { z } from "zod";

export const artifactsSchema = z.object({
  account_id: z.string(),
  call_count: z.number().optional(),
  topics: z.array(z.object({
    name: z.string(), description: z.string().optional(), call_count: z.number().optional(),
    voice_ai_suitability: z.enum(["High", "Medium", "Low"]).optional(),
    rationale: z.string().optional(), example_call_ids: z.array(z.union([z.string(), z.number()])).optional()
  })),
  call_rows: z.array(z.object({
    id: z.union([z.string(), z.number()]).optional(), occurred_at: z.string().optional(),
    topic: z.string().optional(), voice_ai_suitable: z.string().optional(),
    description: z.string().optional(), reasoning: z.string().optional()
  })).default([]),
  bots: z.array(z.object({ id: z.string().optional(), name: z.string().optional(), instructions: z.string().optional() })).default([]),
  recommendations: z.array(z.object({ id: z.string().optional(), name: z.string().optional(), markdown: z.string() })).default([]),
  rewrites: z.array(z.object({ id: z.string().optional(), name: z.string().optional(), text: z.string() })).default([]),
  generated_instructions: z.string().default("")
});
export type Artifacts = z.infer<typeof artifactsSchema>;
export const runSchema = z.object({
  run_id: z.string(), account_id: z.string().nullable(), mode: z.literal("report"),
  status: z.enum(["running", "complete", "error"]), created_at: z.string(),
  finished_at: z.string().nullable(), run_dir: z.string(),
  files: z.record(z.string().nullable()), exit_code: z.number().optional(), error: z.string().optional()
});
export type RunRecord = z.infer<typeof runSchema>;
