import { jobviteSource } from './src/discovery/sources/careerSites/jobvite.js';
import { countryByCode } from '@ja/shared/countries';
const jobs = await jobviteSource.fetchJobs('nutanix', { queries: ['Software Engineer'], country: countryByCode('IN'), onWarning: (w: string) => console.log('warn:', w) } as any);
console.log(jobs.length, 'jobs');
for (const j of jobs.slice(0, 4)) console.log('-', j.title, '|', j.location, '|', j.descriptionText.length, 'chars');
