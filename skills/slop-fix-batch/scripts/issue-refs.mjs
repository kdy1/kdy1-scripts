// Issue identities and PR body reference lines for both trackers.
// GitHub issues are referenced by URL. Linear issues are referenced by identifier,
// because Linear's GitHub integration recognizes identifiers after its magic words.
export const LINEAR_ID = /^[A-Z][A-Z0-9]*-[1-9]\d*$/;
export const isLinear = issue => issue?.tracker === 'linear';
export const isLinearReference = ref => LINEAR_ID.test(ref);
export const issueReference = issue => isLinear(issue) ? issue.identifier : issue.url;
// Linear recognizes `ref`, not `refs`, as a non-closing magic word.
export function referenceLine(kind, ref) {
  const word = kind === 'closes' ? 'Closes' : isLinearReference(ref) ? 'Ref' : 'Refs';
  return `${word} ${ref}`;
}
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GITHUB_CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+([^\n]+)/gi;
const LINEAR_CLOSING = /\b(?:clos(?:e[sd]?|ing)|fix(?:e[sd]|ing)?|resolv(?:e[sd]?|ing)|complet(?:e[sd]?|ing))\s*:?\s+([^\n]+)/gi;
// Returns true when a closing keyword in the text targets the reference or one of its aliases.
export function closesReference(text, ref) {
  if (isLinearReference(ref)) {
    // Linear also accepts issue URLs (`.../issue/ENG-1/slug`) and lowercase identifiers.
    const target = new RegExp(`(?:^|[\\s,(\\[</])${escape(ref)}(?=$|[\\s),.;\\]>/])`, 'i');
    return [...(text ?? '').matchAll(LINEAR_CLOSING)].some(match => target.test(match[1]));
  }
  const number = ref.match(/\/issues\/(\d+)$/)?.[1];
  const repository = ref.match(/^https?:\/\/[^/]+\/(.+)\/issues\/\d+$/)?.[1];
  const targets = [ref, ...(number ? [`#${number}`, `${repository}#${number}`] : [])];
  return [...(text ?? '').matchAll(GITHUB_CLOSING)].some(match =>
    targets.some(target => new RegExp('(?:^|[\\s,(\\[<])' + escape(target) + '(?=$|[\\s),.;\\]>])').test(match[1])));
}
// Linear links a PR whose title or head branch contains the identifier, and such a link
// completes the issue on merge. A non-closing Linear reference must not appear there.
export function linksLinearIssue(value, ref) {
  return new RegExp(`(?:^|[^A-Za-z0-9])${escape(ref)}(?![0-9])`, 'i').test(value ?? '');
}
