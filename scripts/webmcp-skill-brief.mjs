import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ABOUT_BRIEF_START = '<!-- about-brief:start -->';
export const ABOUT_BRIEF_END = '<!-- about-brief:end -->';

export function sliceAboutBrief(skillMarkdown) {
  const start = skillMarkdown.indexOf(ABOUT_BRIEF_START);
  const end = skillMarkdown.indexOf(ABOUT_BRIEF_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('SKILL.md is missing about-brief start/end markers');
  }
  return skillMarkdown.slice(start + ABOUT_BRIEF_START.length, end).trim();
}

export async function writeWebmcpSkillArtifacts({
  skillPath,
  publicDir,
} = {}) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const src = skillPath || join(root, '.agents', 'skills', 'operating-tokenwatch-webmcp', 'SKILL.md');
  const outDir = publicDir || join(root, 'public');
  const skill = await readFile(src, 'utf8');
  const brief = sliceAboutBrief(skill);
  const payload = {
    brief,
    skillUrl: '/skill.md',
  };
  await writeFile(join(outDir, 'skill.md'), skill);
  await writeFile(join(outDir, 'webmcp-about.json'), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  writeWebmcpSkillArtifacts().then((payload) => {
    console.log(`webmcp-skill-brief: wrote public/skill.md and public/webmcp-about.json (${payload.brief.length} brief chars)`);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
