declare module 'virtual:flex-audio-player' {
  import type { FlexAudioPlayer } from '../test/support/flexRuntime';

  /** Version of the installed `@twilio/flex-ui` the audio player modules come from. */
  export const FLEX_UI_VERSION: string;

  /** A fresh, real Flex UI `AudioPlayerManager`, playing through the browser's `<audio>`. */
  export const loadFlexAudioPlayer: () => FlexAudioPlayer;
}
