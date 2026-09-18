import {z} from "zod";

export const invocationIdSchema = z.string().regex(
  /^inv_[A-Za-z0-9]+$/,
  "Use the real invocation ID (inv_...) returned by /run/send or shown in the Restate UI.",
);
