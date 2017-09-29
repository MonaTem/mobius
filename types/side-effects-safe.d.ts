declare module "side-effects-safe";

import { Node } from "babel-types";

export const pureFuncs: string[];
export const pureFuncsRegex: RegExp;

export const pureFuncsWithUnusualException: string[];
export const pureFuncsWithUnusualExceptionRegex: RegExp;

export const pureFuncsWithTypicalException: string[];
export const pureFuncsWithTypicalExceptionRegex: RegExp;

interface PureOptions {
    pureMembers?: RegExp,
    pureCallees?: RegExp
}

export function pureBabylon(node: Node, options?: PureOptions): boolean;
