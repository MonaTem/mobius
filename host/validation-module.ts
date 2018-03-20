import { VirtualModule } from "./virtual-module";
import * as ts from "typescript";
import * as Ajv from "ajv";
import { getDefaultArgs, JsonSchemaGenerator } from "typescript-json-schema";

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
			const symbol: ts.Symbol = (<any>node).symbol;
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
	return localNames.map(name => ({ name, schema: generator.getSchemaForSymbol(name) }));
}

// Ajv configured to support draft-04 JSON schemas
const ajvConfig: Ajv.Options = {
	meta: false,
	extendRefs: true,
	unknownFormats: "ignore",
};
const ajv = new Ajv(ajvConfig);
const draft04Path = "ajv/lib/refs/json-schema-draft-04.json";
ajv.addMetaSchema(require(draft04Path));

export const validationModule: VirtualModule = {
	suffix: "validators",
	generateTypeDeclaration() {
		return `declare const validators: { [symbol: string]: (value: any) => boolean };\n` +
			`export default validators;\n`;
	},
	compileModule(parentPath: string, parentSource: ts.SourceFile, program: ts.Program) {
		const entries: string[] = [];
		for (const { name, schema } of buildSchemas(parentSource, program)) {
			entries.push(` ${JSON.stringify(name)}: validatorForSchema(${JSON.stringify(schema)})`);
		}
		return `import * as Ajv;\n` +
			`const ajv = new Ajv(${JSON.stringify(ajvConfig)});\n` +
			`ajv.addMetaSchema(${JSON.stringify(require(draft04Path))});\n` +
			`function validatorForSchema(schema){\n` +
				`\tconst compiled = ajv.compile(schema);\n` +
				`\treturn function(value) {\n` +
					`\t\treturn !!compiled(value);\n` +
				`\t}\n` +
			`}\n` +
			`export const validators = {${entries.join(",")} };\n` +
			`export default validators;\n`;
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
}
