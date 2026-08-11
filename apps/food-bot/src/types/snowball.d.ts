declare module "snowball" {
  class Snowball {
    constructor(language: string);
    setCurrent(word: string): void;
    stem(): void;
    getCurrent(): string;
  }

  export default Snowball;
}
