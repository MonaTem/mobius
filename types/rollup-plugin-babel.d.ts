import { Plugin } from "rollup";
import { TransformOptions } from "babel-core";

declare module "rollup-plugin-babel";

export default function(options?: TransformOptions) : Plugin;
