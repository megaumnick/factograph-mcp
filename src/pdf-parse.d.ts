// pdf-parse не публикует типы — объявляем минимальный контракт сами.
// mammoth публикует типы сам, поэтому здесь не нужен.
declare module 'pdf-parse' {
  interface PdfParseResult {
    text:      string;
    numpages:  number;
    numrender: number;
    info:      Record<string, unknown>;
    metadata:  unknown;
    version:   string;
  }
  function pdfParse(data: Buffer | Uint8Array): Promise<PdfParseResult>;
  export default pdfParse;
}
