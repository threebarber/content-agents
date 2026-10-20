import { queue } from "@trigger.dev/sdk";

/** On-demand tasks that write the state repo run one at a time, so Slack clicks never race each other. */
export const stateWrites = queue({ name: "state-writes", concurrencyLimit: 1 });
