/**
 * The math renderer. This is the only file that imports KaTeX and the two
 * plugins that drive it, and it is only ever loaded with `import()` (see
 * useMath.ts), so all of it is one chunk that a reply without a formula never
 * fetches.
 */
import type { PluggableList } from 'unified';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

export interface MathPlugins {
  remark: PluggableList;
  rehype: PluggableList;
}

export const MATH_PLUGINS: MathPlugins = {
  // Only "$$" opens math: mathModel.ts decides which single dollars are formulas and rewrites those.
  remark: [[remarkMath, { singleDollarTextMath: false }]],
  // What a model wrote is untrusted: no links, no markup of its own. A formula that can't be set
  // shows its source in the error colour, with the reason as its tooltip, and the reply stays whole.
  rehype: [[rehypeKatex, { trust: false, strict: 'ignore', errorColor: 'var(--g-danger)' }]]
};
