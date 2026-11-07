/** Error con código estable y mensaje en español, seguro de mostrar en la UI. */
export class CitrusError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "CitrusError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
