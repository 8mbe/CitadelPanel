/**
 * Factory for fixed-type Minecraft Java blueprints.
 *
 * The `minecraft-java` blueprint intentionally exposes TYPE as an owner
 * setting. These variants keep the same hardened itzg image and plugin
 * catalog while presenting one software choice in the create form.
 */
import { minecraftJava } from "./minecraft-java";
import type { Blueprint } from "../types";

export function minecraftVariant(
  key: string,
  name: string,
  type: string,
  description: string,
  options: { plugins?: boolean; memoryDefault?: string } = {},
): Blueprint {
  const typeField = minecraftJava.envSchema.TYPE!;
  const memoryField = minecraftJava.envSchema.MEMORY!;
  return {
    ...minecraftJava,
    key,
    name,
    description,
    envSchema: {
      ...minecraftJava.envSchema,
      TYPE: {
        ...typeField,
        required: true,
        default: type,
        options: [type],
        editable: false,
      },
      ...(options.memoryDefault
        ? {
            MEMORY: {
              ...memoryField,
              default: options.memoryDefault,
            },
          }
        : {}),
    },
    ...(options.plugins === false ? { plugins: undefined } : {}),
  };
}
