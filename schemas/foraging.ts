import { z } from "zod";

export const Foraging = z.object({
  exploration_share: z.number().default(0.2),
  exploration_floor: z.number().default(0.1),
  random_slot_per_run: z.number().int().default(1),
  decay_factor_weekly: z.number().default(0.85),
  hit_rules: z
    .object({
      engagement_z_min: z.number().default(1),
      hook_quality_min: z.number().default(4),
      approved_card_bonus: z.number().default(2),
      manual_save_bonus: z.number().default(3),
    })
    .prefault({}),
  trial: z
    .object({
      items: z.number().int().default(5),
      pass_hook_quality_mean: z.number().default(3.5),
      pass_relevance_min: z.number().default(0.4),
    })
    .prefault({}),
  promotion: z
    .object({
      trial_to_active_hits: z.number().default(3),
      trial_window_weeks: z.number().default(3),
      auto_promotions_per_week: z.number().default(3),
    })
    .prefault({}),
  demotion: z
    .object({
      active_to_paused_hits_below: z.number().default(0.5),
      active_to_paused_weeks: z.number().default(8),
      paused_to_retired_weeks: z.number().default(12),
    })
    .prefault({}),
  caps: z
    .object({
      active_per_type: z.record(z.string(), z.number()).prefault({}),
      topic_cluster_max_share: z.number().default(0.4),
    })
    .prefault({}),
});
export type Foraging = z.infer<typeof Foraging>;
