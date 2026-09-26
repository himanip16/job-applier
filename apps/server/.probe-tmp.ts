import { countryByCode } from '@ja/shared';
import { sourceById } from '/Users/himani/Documents/projects/job-applier/apps/server/src/discovery/sources/index.ts';
const cases: [string, string][] = [['greenhouse','stripe'],['lever','cred'],['ashby','openai'],['workable','bayutdubizzle'],
  ['workday','nvidia.wd5/NVIDIAExternalCareerSite'],['workday','crowdstrike.wd5/crowdstrikecareers'],['workday','cohesity.wd5/Cohesity_Careers'],
  ['smartrecruiters','ServiceNow'],['smartrecruiters','AristaNetworks'],
  ['eightfold','explore.jobs.netflix.net|netflix.com'],['eightfold','mlp.eightfold.ai|mlp.com'],['eightfold','apply.careers.microsoft.com|microsoft.com'],
  ['google','google'],['apple','apple'],['linkedin-company','1337'],['jibe','jobs.booking.com'],['rippling','rippling'],['atlassian','atlassian'],['radancy','jobs.intuit.com'],
];
const only = process.argv[2]?.split(',');
const hints = { queries: ['Software Engineer'], country: countryByCode('IN') };
await Promise.all(cases.filter(([id]) => !only || only.includes(id)).map(async ([id, h]) => {
  const t = Date.now();
  try {
    const jobs = await sourceById(id)!.fetchJobs(h, hints);
    const j = jobs[0];
    console.log(`${id}/${h}: ${jobs.length} in ${((Date.now()-t)/1000).toFixed(0)}s | ${j?.title} | ${j?.location} | desc=${j?.descriptionText.length} | ${j?.postedAt?.toISOString().slice(0,10)} | ${j?.url}`);
  } catch (e) { console.log(`${id}/${h}: ERROR ${(e as Error).message}`); }
}));
