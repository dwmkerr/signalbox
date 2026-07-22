// The qrcode package ships no types and @types/qrcode is not a dependency, so
// declare just the one call the pair command makes: terminal-rendered strings.
declare module "qrcode" {
  interface QRCodeRenderOptions {
    type?: "terminal" | "utf8" | "svg";
    small?: boolean;
  }
  export function toString(text: string, options?: QRCodeRenderOptions): Promise<string>;
  const qrcode: { toString: typeof toString };
  export default qrcode;
}
