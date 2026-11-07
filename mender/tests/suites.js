// The list of test suites, shared by the browser page (index.html) and the command line (run.mjs).
import { tests as parcel } from './mender.test.js';
import { conversions, moving, safety, adapters, proof } from './rules.edge.test.js';
import { evidence, kinds, shapes } from './infer.edge.test.js';
import { versions, requests, answers, failures, forms } from './runtime.edge.test.js';
import { reading, endpoints, judgement, formats } from './openapi.edge.test.js';
import { quotes, live, liveEnabled } from './quotes.test.js';
import { managed } from './managed.test.js';
import { codefix } from './codefix.test.js';

export const suites = [
  ['Parcel walkthrough: adapter, replay, rules', parcel],
  ['Rules: converting values', conversions],
  ['Rules: moving fields', moving],
  ['Rules: safety and validation', safety],
  ['Rules: compiled adapters', adapters],
  ['Rules: proof', proof],
  ['Rule finder: weighing evidence', evidence],
  ['Rule finder: kinds of change', kinds],
  ['Rule finder: lists and shapes', shapes],
  ['Runtime: versions', versions],
  ['Runtime: requests of every kind', requests],
  ['Runtime: answers of every kind', answers],
  ['Runtime: when something fails', failures],
  ['Runtime: form bodies', forms],
  ['Specs: reading field changes', reading],
  ['Specs: endpoints and parameters', endpoints],
  ['Specs: judgement calls', judgement],
  ['Specs: formats and robustness', formats],
  ['Quotes API: the unchanged consumer keeps working', quotes],
  ['Managed Quote API: versions published one after another', managed],
  ['Consumer fix: rewriting the request from the rules', codefix],
  ...(liveEnabled ? [['Quotes API, deployed: real calls', live]] : []),
];
