// Sequence links look like onlinesequencer.net/1234567 or onlinesequencer.net/playlist/50433/1234567.
export function parseSequenceId(text: string): string | null {
  const match = /onlinesequencer\.net\/(?:playlist\/\d+\/)?(\d+)\b/i.exec(text.trim());
  return match ? match[1] : null;
}
