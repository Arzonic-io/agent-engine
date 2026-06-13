import { BadRequestException, type PipeTransform } from "@nestjs/common";
import { z } from "zod";

export const StartRunSchema = z.object({
  task: z.string().min(1, "task must not be empty").max(20_000),
  rubricId: z.string().min(1).optional(),
  options: z
    .object({
      maxRounds: z.number().int().min(1).max(20).optional(),
    })
    .optional(),
});
export type StartRunDto = z.infer<typeof StartRunSchema>;

export const DecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  notes: z.string().max(10_000).optional(),
});
export type DecisionDto = z.infer<typeof DecisionSchema>;

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(
        result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      );
    }
    return result.data;
  }
}
