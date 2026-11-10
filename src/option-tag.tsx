import type { ReactNode } from "react";

export type OptionTone = "blue" | "rose" | "teal" | "amber" | "violet" | "green" | "slate";
const tones: OptionTone[] = ["blue", "rose", "teal", "amber", "violet", "green"];
const fixedTones: Record<string, OptionTone> = {
  结构物料: "blue", 电子物料: "violet", 一级物料: "blue", 二级物料: "violet",
  已发货: "green", 待发货: "amber",
};

export function OptionTag({ label, tone, colorKey, children }: {
  label: string; tone?: OptionTone; colorKey?: string; children?: ReactNode;
}) {
  let hash = 0;
  for (const char of (colorKey || label).normalize("NFKC").toLowerCase()) {
    hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  }
  const color = tone || (Object.hasOwn(fixedTones, label) ? fixedTones[label] : tones[hash % tones.length]);
  return <span className={"option-tag " + color} title={label}>{children ?? label}</span>;
}
