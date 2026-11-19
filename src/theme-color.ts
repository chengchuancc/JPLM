export const defaultCustomColor = "#517ab4";
export const isThemeColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

function channels(hex: string) {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
}

function hexColor(rgb: number[]) {
  return "#" + rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("");
}

export function colorHue(hex: string) {
  const [red, green, blue] = channels(hex);
  const high = Math.max(red, green, blue);
  const chroma = high - Math.min(red, green, blue);
  if (!chroma) return 0;
  const sector = high === red ? (green - blue) / chroma
    : high === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
  return Math.round((sector * 60 + 360) % 360) % 360;
}

export function colorAtHue(hue: number) {
  // Use a steady lightness and saturation while rotating around the wheel.
  const lightness = .55;
  const amplitude = .65 * (1 - lightness);
  return hexColor([0, 8, 4].map((offset) => {
    const angle = (offset + hue / 30) % 12;
    return 255 * (lightness - amplitude * Math.max(-1, Math.min(angle - 3, 9 - angle, 1)));
  }));
}

export function readableAccent(hex: string) {
  const rgb = channels(hex);
  const weights = [.2126, .7152, .0722];
  const contrast = (scale: number) => {
    const luminance = rgb.reduce((sum, channel, index) => {
      const value = Math.round(channel * scale) / 255;
      const linear = value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      return sum + weights[index] * linear;
    }, 0);
    return 1.05 / (luminance + .05);
  };
  if (contrast(1) >= 4.5) return hex;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 12; i++) {
    const next = (high + low) / 2;
    if (contrast(next) >= 4.5) low = next;
    else high = next;
  }
  return hexColor(rgb.map((channel) => channel * low));
}
