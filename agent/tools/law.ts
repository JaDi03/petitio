import { z } from "zod";

import { LAW, REGULATION_URL, type LawRef } from "../knowledge/eu261/law.js";
import { defineTool } from "./tool.js";

const refs = Object.keys(LAW) as [LawRef, ...LawRef[]];

export const getLaw = defineTool({
  name: "get_law",
  description:
    "Return the exact text of one provision of EU Regulation 261/2004 to quote to the airline. Use it instead of quoting from memory.",
  schema: z.object({ ref: z.enum(refs) }).strict(),
  run({ ref }) {
    return Promise.resolve({ ref, text: LAW[ref], source: REGULATION_URL });
  },
});
