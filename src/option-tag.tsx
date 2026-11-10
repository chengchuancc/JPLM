import type { ReactNode } from "react";

export type OptionTone = "blue" | "rose" | "teal" | "amber" | "violet" | "green" | "slate" |
  "cyan" | "orange" | "pink" | "indigo" | "olive";
const tones: OptionTone[] = ["blue", "rose", "teal", "amber", "violet", "green"];
const categoryTones: Record<string, OptionTone> = { 结构物料: "blue", 电子物料: "violet", 成品定制: "amber" };
const customTones: OptionTone[] = ["teal", "rose", "green", "orange", "indigo", "cyan", "pink", "olive", "slate"];
const fixedTones: Record<string, OptionTone> = {
  ...categoryTones, 一级物料: "blue", 二级物料: "violet",
  已发货: "green", 待发货: "amber", 待入库: "slate", 部分入库: "amber", 已全部入库: "green",
  入库: "green", 出库: "blue", 退库: "teal", 报废: "rose",
};

export function materialCategoryTone(name: string, categories: string[]): OptionTone {
  if (Object.hasOwn(categoryTones, name)) return categoryTones[name];
  const custom = categories.filter((category) => !Object.hasOwn(categoryTones, category));
  return customTones[Math.max(0, custom.indexOf(name)) % customTones.length];
}

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
