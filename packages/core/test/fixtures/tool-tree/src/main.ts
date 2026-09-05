import { helloUtil } from './util.js';

export function main(): string {
  const message = helloUtil('tool-tree');
  console.log(message);
  return message;
}
