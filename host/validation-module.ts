import * as Ajv from "ajv";
import * as ts from "typescript";
import { getDefaultArgs, JsonSchemaGenerator } from "typescript-json-schema";
import * as babylon from "babylon";
import * as babel from "babel-core";
import { NodePath } from "babel-traverse";
import { AssignmentExpression, IfStatement, Identifier, VariableDeclaration } from "babel-types";
import { VirtualModule } from "./virtual-module";

function buildSchemas(sourceFile: ts.SourceFile, program: ts.Program) {
	const localNames: string[] = [];
	const tc = program.getTypeChecker();
	const allSymbols: { [name: string]: ts.Type } = {};
	const userSymbols: { [name: string]: ts.Symbol } = {};
	const inheritingTypes: { [baseName: string]: string[] } = {};
	function visit(node: ts.Node) {
		if (node.kind === ts.SyntaxKind.ClassDeclaration
			|| node.kind === ts.SyntaxKind.InterfaceDeclaration
		 	|| node.kind === ts.SyntaxKind.EnumDeclaration
			|| node.kind === ts.SyntaxKind.TypeAliasDeclaration
		) {
			const symbol: ts.Symbol = (node as any).symbol;
			const localName = tc.getFullyQualifiedName(symbol).replace(/".*"\./, "");
			const nodeType = tc.getTypeAtLocation(node);
   allSymbols[localName] = nodeType;
			localNames.push(localName);
   userSymbols[localName] = symbol;
			for (const baseType of nodeType.getBaseTypes() || []) {
				const baseName = tc.typeToString(baseType, undefined, ts.TypeFormatFlags.UseFullyQualifiedType);
				(inheritingTypes[baseName] || (inheritingTypes[baseName] = [])).push(localName);
			}
		} else {
			ts.forEachChild(node, visit);
		}
	}
	visit(sourceFile);
	const generator = new JsonSchemaGenerator(allSymbols, userSymbols, inheritingTypes, tc, Object.assign({
		strictNullChecks: true,
		ref: true,
		topRef: true,
		required: true,
	}, getDefaultArgs()));
	return localNames.map((name) => ({ name, schema: generator.getSchemaForSymbol(name) }));
}

// Ajv configured to support draft-04 JSON schemas
const ajv = new Ajv({
	meta: false,
	extendRefs: true,
	unknownFormats: "ignore"
});
ajv.addMetaSchema(require("ajv/lib/refs/json-schema-draft-04.json"));

// Unsafe, but successfully strips out the assignment of validate.errors
const rewriteAjv = {
	visitor: {
		VariableDeclaration(path: NodePath<VariableDeclaration>) {
			if (path.node.declarations.length === 1) {
				const identifier = path.node.declarations[0].id as Identifier;
				if (identifier.name === "err" || identifier.name === "vErrors") {
					path.remove();
				}
			}
		},
		IfStatement(path: NodePath<IfStatement>) {
			const test = path.get("test");
			if (test.isBinaryExpression()) {
				const left = test.get("left");
				if (left.isIdentifier() && (left.node as Identifier).name === "vErrors") {
					path.remove();
				}
			}
		},
		AssignmentExpression(path: NodePath<AssignmentExpression>) {
			const left = path.get("left");
			if (left.isMemberExpression()) {
				const object = left.get("object");
				if (object.isIdentifier() && (object.node as Identifier).name === "validate") {
					path.remove();
				}
			}
		},
	},
};

export const validationModule: VirtualModule = {
	suffix: "validators",
	generateTypeDeclaration() {
		return `declare const validators: { [symbol: string]: (value: any) => boolean };\n` +
			`export default validators;\n`;
	},
	compileModule(parentPath: string, parentSource: ts.SourceFile, program: ts.Program) {
		const entries: string[] = [];
		for (const { name, schema } of buildSchemas(parentSource, program)) {
			entries.push(` ${JSON.stringify(name)}: ${ajv.compile(schema).toString()}`);
		}
		const original = `export const validators = {${entries.join(",")} };\n` +
			`export default validators;\n`;
		const ast = babylon.parse(original, { sourceType: "module" });
		return babel.transformFromAst(ast, original, { plugins: [[rewriteAjv, {}]], compact: true }).code!;
	},
	instantiateModule(parentPath: string, parentSource: ts.SourceFile, program: ts.Program) {
		const validators: { [symbol: string]: (value: any) => boolean } = {};
		for (const { name, schema } of buildSchemas(parentSource, program)) {
			const compiled = ajv.compile(schema);
			validators[name] = (value: any) => !!compiled(value);
		}
		return (global) => {
			global.exports.__esModule = true;
			global.exports.default = global.exports.validators = validators;
		};
	},
};
