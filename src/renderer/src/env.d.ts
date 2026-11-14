import type { LearnPianoApi } from "../../shared/types";

declare global {
  interface Window {
    learnPiano: LearnPianoApi;
  }
}
