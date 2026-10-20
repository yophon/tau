// highlight.js 10.7.3 declares its subpath modules only inside its main types file, which a
// subpath import does not load (pi carries the same declarations, utils/highlight-js.d.ts).
interface HighlightJsLanguage {
	readonly name?: string;
}

type HighlightJsLanguageFactory = (hljs: HighlightJsApi) => HighlightJsLanguage;

interface HighlightJsApi {
	highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
	getLanguage(name: string): HighlightJsLanguage | undefined;
	registerLanguage(name: string, language: HighlightJsLanguageFactory): void;
}

declare module "highlight.js/lib/core.js" {
	const hljs: HighlightJsApi;
	export default hljs;
}

declare module "highlight.js/lib/languages/*" {
	const language: HighlightJsLanguageFactory;
	export default language;
}
