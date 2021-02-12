declare namespace redis {
  function call(this: void, ...args: string[]): void;
  function pcall(this: void, ...args: string[]): void;
}

declare const KEYS: string[];
declare const ARGV: string[];
