import { PrismaClient } from './generated/prisma';

const prisma = new PrismaClient();

const companies = [
  {
    "company": "Apple",
    "domain": "apple.com",
    "job_links": []
  },
  {
    "company": "Kredivo Group",
    "domain": "kredivo.com",
    "job_links": []
  },
  {
    "company": "Amazon",
    "domain": "amazon.com",
    "job_links": []
  },
  {
    "company": "Menlo Security",
    "domain": "menlosecurity.com",
    "job_links": []
  },
  {
    "company": "Cvent",
    "domain": "cvent.com",
    "job_links": []
  },
  {
    "company": "Dezerv",
    "domain": "dezerv.in",
    "job_links": []
  },
  {
    "company": "Swish",
    "domain": "swish.in",
    "job_links": []
  },
  {
    "company": "Suki",
    "domain": "suki.ai",
    "job_links": []
  },
  {
    "company": "Sigmoid",
    "domain": "sigmoid.com",
    "job_links": []
  },
  {
    "company": "AiPrise",
    "domain": "aiprise.com",
    "job_links": []
  },
  {
    "company": "Broccoli AI",
    "domain": "broccoli.ai",
    "job_links": []
  },
  {
    "company": "Zinier",
    "domain": "zinier.com",
    "job_links": []
  },
  {
    "company": "aion",
    "domain": "aion.xyz",
    "job_links": []
  },
  {
    "company": "Blitz",
    "domain": "growblitz.com",
    "job_links": []
  },
  {
    "company": "SolarWinds",
    "domain": "solarwinds.com",
    "job_links": []
  },
  {
    "company": "Uber",
    "domain": "uber.com",
    "job_links": [
      "https://www.uber.com/careers/list/"
    ]
  },
  {
    "company": "Deliveroo",
    "domain": "deliveroo.com",
    "job_links": [
      "https://careers.deliveroo.co.uk/"
    ]
  },
  {
    "company": "DocuSign",
    "domain": "docusign.com",
    "job_links": [
      "https://careers.docusign.com/careers-home/jobs/29553?lang=en-us&previousLocale=en-US",
      "https://careers.docusign.com/careers-home/jobs/29590?lang=en-us&previousLocale=en-US"
    ]
  },
  {
    "company": "Booking.com",
    "domain": "booking.com",
    "job_links": [
      "https://jobs.booking.com/booking/jobs/26708?lang=en-us",
      "https://jobs.booking.com/booking/jobs/29053?lang=en-us"
    ]
  },
  {
    "company": "Adyen",
    "domain": "adyen.com",
    "job_links": [
      "https://careers.adyen.com/vacancies/6761873-java-software-engineer-cx?locale=en",
      "https://careers.adyen.com/vacancies/7369512-java-software-engineer-payments?locale=en"
    ]
  },
  {
    "company": "Wise",
    "domain": "wise.com",
    "job_links": [
      "https://wise.jobs/"
    ]
  },
  {
    "company": "Spotify",
    "domain": "spotify.com",
    "job_links": [
      "https://www.lifeatspotify.com/jobs/senior-backend-engineer-podcast",
      "https://www.lifeatspotify.com/jobs/senior-backend-engineer-subscriptions"
    ]
  },
  {
    "company": "Zalando",
    "domain": "zalando.com",
    "job_links": [
      "https://jobs.zalando.com/"
    ]
  },
  {
    "company": "Proofpoint",
    "domain": "proofpoint.com",
    "job_links": [
      "https://proofpoint.wd5.myworkdayjobs.com/proofpointcareers/job/India/Sr-Software-Engineer_R14235"
    ]
  },
  {
    "company": "Zomato",
    "domain": "zomato.com",
    "job_links": []
  },
  {
    "company": "Adobe",
    "domain": "adobe.com",
    "job_links": [
      "https://careers.adobe.com/us/en/job/R170239/Computer-Scientist-2-Full-Stack",
      "https://careers.adobe.com/us/en/job/R170358/Computer-Scientist-2",
      "https://careers.adobe.com/us/en/job/R171037/Software-Development-Engineer"
    ]
  },
  {
    "company": "Intuit",
    "domain": "intuit.com",
    "job_links": [
      "https://jobs.intuit.com/job/bengaluru/ck-senior-software-engineer/27595/99834291648?cid=seo_google"
    ]
  },
  {
    "company": "Klarna",
    "domain": "klarna.com",
    "job_links": [
      "https://www.klarna.com/careers/"
    ]
  },
  {
    "company": "Revolut",
    "domain": "revolut.com",
    "job_links": [
      "https://www.revolut.com/careers/"
    ]
  },
  {
    "company": "Rubrik",
    "domain": "rubrik.com",
    "job_links": [
      "https://www.rubrik.com/company/careers/departments/job.8121053.1929?reqId=INSW11244"
    ]
  },
  {
    "company": "Rippling",
    "domain": "rippling.com",
    "job_links": [
      "https://ats.rippling.com/rippling/jobs/c27bb856-8044-4253-a1e2-948ee96fd760",
      "https://ats.rippling.com/rippling/jobs/a91be8b6-be18-4fad-9738-5b5f40bd14f4",
      "https://ats.rippling.com/rippling/jobs/68688777-396b-42db-a7dd-e4c8d19e747c",
      "https://ats.rippling.com/rippling/jobs/266cf368-4d6b-4317-a911-76b9219ae28e"
    ]
  },
  {
    "company": "Mollie",
    "domain": "mollie.com",
    "job_links": [
      "https://www.mollie.com/careers"
    ]
  },
  {
    "company": "Contentful",
    "domain": "contentful.com",
    "job_links": [
      "https://www.contentful.com/careers/"
    ]
  },
  {
    "company": "Personio",
    "domain": "personio.com",
    "job_links": [
      "https://www.personio.com/about-personio/careers/"
    ]
  },
  {
    "company": "Celonis",
    "domain": "celonis.com",
    "job_links": [
      "https://www.celonis.com/careers/"
    ]
  },
  {
    "company": "Bolt",
    "domain": "bolt.eu",
    "job_links": [
      "https://bolt.eu/en/careers/"
    ]
  },
  {
    "company": "SumUp",
    "domain": "sumup.com",
    "job_links": [
      "https://www.sumup.com/careers/"
    ]
  },
  {
    "company": "GoCardless",
    "domain": "gocardless.com",
    "job_links": [
      "https://gocardless.com/careers/"
    ]
  },
  {
    "company": "Checkout.com",
    "domain": "checkout.com",
    "job_links": [
      "https://www.checkout.com/careers"
    ]
  },
  {
    "company": "Rapyd",
    "domain": "rapyd.net",
    "job_links": [
      "https://www.rapyd.net/careers/"
    ]
  },
  {
    "company": "Ebury",
    "domain": "ebury.com",
    "job_links": [
      "https://www.ebury.com/careers/"
    ]
  },
  {
    "company": "Delivery Hero",
    "domain": "deliveryhero.com",
    "job_links": [
      "https://www.deliveryhero.com/careers/"
    ]
  },
  {
    "company": "Amazon",
    "domain": "amazon.com",
    "job_links": [
      "https://www.amazon.jobs/en/jobs/10523240/sde-ii-global-trade-level-5-global-trade-foundations",
      "https://www.amazon.jobs/en/jobs/10499456/software-development-engineer-ii-fintelligence-workplace",
      "https://www.amazon.jobs/en/jobs/10513792/software-development-engineer-ii-shiptech-analytics"
    ]
  },
  {
    "company": "Meta",
    "domain": "meta.com",
    "job_links": [
      "https://www.metacareers.com/"
    ]
  },
  {
    "company": "Google",
    "domain": "google.com",
    "job_links": [
      "https://www.google.com/about/careers/applications/jobs/results/131817929036440262-software-engineer-iii-infrastructure-google-cloud?q=%22Software%20Engineer%20III%22&location=India&hl=en-GB&target_level=MID",
      "https://www.google.com/about/careers/applications/jobs/results/111602324891148998-software-engineer-iii-payments?q=%22Software%20Engineer%20III%22&location=India&hl=en-GB&target_level=MID",
      "https://www.google.com/about/careers/applications/jobs/results/96981905538196166-software-engineer-iii-google-cloud?q=%22Software%20Engineer%20III%22&location=India&hl=en-GB&target_level=MID",
      "https://www.google.com/about/careers/applications/jobs/results/101212497425375942-software-engineer-iii-full-stack-google-cloud?q=%22Software%20Engineer%20III%22&location=India&hl=en-GB&target_level=MID",
      "https://www.google.com/about/careers/applications/jobs/results/118404496526058182-software-engineer-iii-full-stack?q=%22Software%20Engineer%20III%22&location=India&hl=en-GB&target_level=MID"
    ]
  },
  {
    "company": "Microsoft",
    "domain": "microsoft.com",
    "job_links": [
      "https://apply.careers.microsoft.com/careers?start=0&location=Bangalore&pid=1970393556978846",
      "https://apply.careers.microsoft.com/careers?start=0&location=Bangalore&pid=1970393556911611",
      "https://apply.careers.microsoft.com/careers?start=0&location=Bangalore&pid=1970393556978845",
      "https://apply.careers.microsoft.com/careers?start=0&location=Bangalore&pid=1970393556982368",
      "https://apply.careers.microsoft.com/careers?start=0&location=Bangalore&pid=1970393556876286"
    ]
  },
  {
    "company": "Apple",
    "domain": "apple.com",
    "job_links": [
      "https://jobs.apple.com/en-in/details/200675619-0321/software-development-engineer?team=SFTWR",
      "https://jobs.apple.com/en-in/details/200674285-1052/software-engineer-java?team=SFTWR",
      "https://jobs.apple.com/en-in/details/200677235-1052/software-engineer-distributed-systems?team=SFTWR"
    ]
  },
  {
    "company": "Netflix",
    "domain": "netflix.com",
    "job_links": [
      "https://jobs.netflix.com/"
    ]
  },
  {
    "company": "Stripe",
    "domain": "stripe.com",
    "job_links": [
      "https://stripe.com/jobs"
    ]
  },
  {
    "company": "Swiggy",
    "domain": "swiggy.com",
    "job_links": []
  },
  {
    "company": "Airbnb",
    "domain": "airbnb.com",
    "job_links": [
      "https://careers.airbnb.com/"
    ]
  },
  {
    "company": "Datadog",
    "domain": "datadoghq.com",
    "job_links": [
      "https://careers.datadoghq.com/",
      "https://careers.datadoghq.com/detail/7993551/?gh_jid=7993551"
    ]
  },
  {
    "company": "Cloudflare",
    "domain": "cloudflare.com",
    "job_links": [
      "https://www.cloudflare.com/careers/",
      "https://job-boards.greenhouse.io/cloudflare/jobs/8168623?gh_jid=8168623",
      "https://job-boards.greenhouse.io/cloudflare/jobs/8124227?gh_jid=8124227",
      "https://job-boards.greenhouse.io/cloudflare/jobs/8022909?gh_jid=8022909",
      "https://job-boards.greenhouse.io/cloudflare/jobs/8014902?gh_jid=8014902"
    ]
  },
  {
    "company": "GitLab",
    "domain": "gitlab.com",
    "job_links": [
      "https://about.gitlab.com/jobs/"
    ]
  },
  {
    "company": "GitHub",
    "domain": "github.com",
    "job_links": [
      "https://www.github.careers/"
    ]
  },
  {
    "company": "Groupon",
    "domain": "groupon.com",
    "job_links": [
      "https://job-boards.eu.greenhouse.io/groupon/jobs/4963940101"
    ]
  },
  {
    "company": "Atlassian",
    "domain": "atlassian.com",
    "job_links": [
      "https://www.atlassian.com/company/careers"
    ]
  },
  {
    "company": "Shopify",
    "domain": "shopify.com",
    "job_links": [
      "https://www.shopify.com/careers"
    ]
  },
  {
    "company": "Twilio",
    "domain": "twilio.com",
    "job_links": [
      "https://www.twilio.com/en-us/company/jobs"
    ]
  },
  {
    "company": "Okta",
    "domain": "okta.com",
    "job_links": [
      "https://www.okta.com/company/careers/business-technology/senior-software-engineer-5781654/"
    ]
  },
  {
    "company": "HubSpot",
    "domain": "hubspot.com",
    "job_links": [
      "https://www.hubspot.com/careers"
    ]
  },
  {
    "company": "Salesforce",
    "domain": "salesforce.com",
    "job_links": []
  },
  {
    "company": "ServiceNow",
    "domain": "servicenow.com",
    "job_links": [
      "https://careers.servicenow.com/jobs/744000144803914/senior-software-engineer-core-platform-moveworks/",
      "https://careers.servicenow.com/jobs/744000142603654/sr-software-engineer-cloud-platform-kubernetes-hyperscalers-distributed-systems/"
    ]
  },
  {
    "company": "Oracle",
    "domain": "oracle.com",
    "job_links": [
      "https://careers.oracle.com/en/sites/jobsearch/jobs/preview/336802/?location=India&locationId=300000000106947",
      "https://careers.oracle.com/en/sites/jobsearch/jobs/preview/337477/?keyword=Software+Engineering&location=India&locationId=300000000106947"
    ]
  },
  {
    "company": "SAP",
    "domain": "sap.com",
    "job_links": [
      "https://www.sap.com/about/careers.html"
    ]
  },
  {
    "company": "NVIDIA",
    "domain": "nvidia.com",
    "job_links": [
      "https://www.nvidia.com/en-us/about-nvidia/careers/"
    ]
  },
  {
    "company": "Qualcomm",
    "domain": "qualcomm.com",
    "job_links": [
      "https://www.qualcomm.com/company/careers"
    ]
  },
  {
    "company": "Intel",
    "domain": "intel.com",
    "job_links": [
      "https://jobs.intel.com/"
    ]
  },
  {
    "company": "Palantir",
    "domain": "palantir.com",
    "job_links": [
      "https://www.palantir.com/careers/"
    ]
  },
  {
    "company": "Databricks",
    "domain": "databricks.com",
    "job_links": [
      "https://www.databricks.com/company/careers"
    ]
  },
  {
    "company": "Snowflake",
    "domain": "snowflake.com",
    "job_links": [
      "https://careers.snowflake.com/"
    ]
  },
  {
    "company": "MongoDB",
    "domain": "mongodb.com",
    "job_links": [
      "https://www.mongodb.com/careers"
    ]
  },
  {
    "company": "Confluent",
    "domain": "confluent.io",
    "job_links": [
      "https://www.confluent.io/careers/"
    ]
  },
  {
    "company": "Elastic",
    "domain": "elastic.co",
    "job_links": [
      "https://www.elastic.co/about/careers"
    ]
  },
  {
    "company": "Grafana Labs",
    "domain": "grafana.com",
    "job_links": [
      "https://grafana.com/about/careers/"
    ]
  },
  {
    "company": "Snyk",
    "domain": "snyk.io",
    "job_links": [
      "https://snyk.io/careers/"
    ]
  },
  {
    "company": "Miro",
    "domain": "miro.com",
    "job_links": [
      "https://miro.com/careers/"
    ]
  },
  {
    "company": "Canva",
    "domain": "canva.com",
    "job_links": [
      "https://www.canva.com/careers/"
    ]
  },
  {
    "company": "Kula AI",
    "domain": "kula.ai",
    "job_links": [
      "https://careers.kula.ai/zamp-ai/34309"
    ]
  },
  {
    "company": "Replit",
    "domain": "replit.com",
    "job_links": [
      "https://replit.com/careers"
    ]
  },
  {
    "company": "Vercel",
    "domain": "vercel.com",
    "job_links": [
      "https://vercel.com/careers"
    ]
  },
  {
    "company": "Figma",
    "domain": "figma.com",
    "job_links": [
      "https://www.figma.com/careers/"
    ]
  },
  {
    "company": "Dropbox",
    "domain": "dropbox.com",
    "job_links": [
      "https://jobs.dropbox.com/"
    ]
  },
  {
    "company": "Box",
    "domain": "box.com",
    "job_links": [
      "https://www.box.com/en-us/careers"
    ]
  },
  {
    "company": "Zoom",
    "domain": "zoom.us",
    "job_links": [
      "https://careers.zoom.us/"
    ]
  },
  {
    "company": "Workday",
    "domain": "workday.com",
    "job_links": [
      "https://www.workday.com/en-us/company/careers.html"
    ]
  },
  {
    "company": "Deel",
    "domain": "deel.com",
    "job_links": [
      "https://www.deel.com/careers"
    ]
  },
  {
    "company": "Remote",
    "domain": "remote.com",
    "job_links": [
      "https://remote.com/careers"
    ]
  },
  {
    "company": "Ramp",
    "domain": "ramp.com",
    "job_links": [
      "https://ramp.com/careers"
    ]
  },
  {
    "company": "Brex",
    "domain": "brex.com",
    "job_links": [
      "https://www.brex.com/careers"
    ]
  },
  {
    "company": "Plaid",
    "domain": "plaid.com",
    "job_links": [
      "https://plaid.com/careers/"
    ]
  },
  {
    "company": "Chime",
    "domain": "chime.com",
    "job_links": [
      "https://www.chime.com/careers/"
    ]
  },
  {
    "company": "Coinbase",
    "domain": "coinbase.com",
    "job_links": [
      "https://www.coinbase.com/careers"
    ]
  },
  {
    "company": "Block",
    "domain": "block.xyz",
    "job_links": [
      "https://block.xyz/careers"
    ]
  },
  {
    "company": "Affirm",
    "domain": "affirm.com",
    "job_links": [
      "https://www.affirm.com/careers"
    ]
  },
  {
    "company": "N26",
    "domain": "n26.com",
    "job_links": [
      "https://n26.com/en-eu/careers"
    ]
  },
  {
    "company": "Trade Republic",
    "domain": "traderepublic.com",
    "job_links": [
      "https://traderepublic.com/en-de/careers"
    ]
  },
  {
    "company": "Scalable Capital",
    "domain": "scalable.capital",
    "job_links": [
      "https://de.scalable.capital/careers"
    ]
  },
  {
    "company": "SumUp",
    "domain": "sumup.com",
    "job_links": [
      "https://www.sumup.com/careers/"
    ]
  },
  {
    "company": "Back Market",
    "domain": "backmarket.com",
    "job_links": [
      "https://careers.backmarket.com/"
    ]
  },
  {
    "company": "Vinted",
    "domain": "vinted.com",
    "job_links": [
      "https://careers.vinted.com/"
    ]
  },
  {
    "company": "Pleo",
    "domain": "pleo.io",
    "job_links": [
      "https://www.pleo.io/en/careers"
    ]
  },
  {
    "company": "Catawiki",
    "domain": "catawiki.com",
    "job_links": [
      "https://careers.catawiki.com/"
    ]
  },
  {
    "company": "TomTom",
    "domain": "tomtom.com",
    "job_links": [
      "https://www.tomtom.com/careers/"
    ]
  },
  {
    "company": "ASML",
    "domain": "asml.com",
    "job_links": [
      "https://www.asml.com/en/careers"
    ]
  },
  {
    "company": "Booking Holdings",
    "domain": "bookingholdings.com",
    "job_links": [
      "https://www.bookingholdings.com/careers/"
    ]
  },
  {
    "company": "Expedia Group",
    "domain": "expediagroup.com",
    "job_links": [
      "https://careers.expediagroup.com/"
    ]
  },
  {
    "company": "eBay",
    "domain": "ebay.com",
    "job_links": [
      "https://jobs.ebayinc.com/"
    ]
  },
  {
    "company": "Wolt",
    "domain": "wolt.com",
    "job_links": [
      "https://careers.wolt.com/"
    ]
  },
  {
    "company": "Just Eat Takeaway",
    "domain": "justeattakeaway.com",
    "job_links": [
      "https://careers.justeattakeaway.com/"
    ]
  },
  {
    "company": "HelloFresh",
    "domain": "hellofreshgroup.com",
    "job_links": [
      "https://careers.hellofreshgroup.com/"
    ]
  },
  {
    "company": "GetYourGuide",
    "domain": "getyourguide.com",
    "job_links": [
      "https://www.getyourguide.careers/"
    ]
  },
  {
    "company": "Flink",
    "domain": "flink.com",
    "job_links": [
      "https://www.goflink.com/en/career/"
    ]
  },
  {
    "company": "Gorillas",
    "domain": "gorillas.io",
    "job_links": [
      "https://gorillas.io/en/careers/"
    ]
  },
  {
    "company": "Abnormal AI",
    "domain": "abnormalsecurity.com",
    "job_links": [
      "https://abnormal.ai/careers/jobs/7816911003?gh_jid=7816911003",
      "https://abnormal.ai/careers/jobs/7884804003?gh_jid=7884804003",
      "https://abnormal.ai/careers/jobs/7741028003?gh_jid=7741028003"
    ]
  },
  {
    "company": "PayPay",
    "domain": "paypay.ne.jp",
    "job_links": [
      "https://job-boards.greenhouse.io/pay2dc/jobs/4024283006"
    ]
  },
  {
    "company": "Glean",
    "domain": "glean.com",
    "job_links": []
  },
  {
    "company": "Novaex.ai",
    "domain": "novaex.ai",
    "job_links": []
  },
  {
    "company": "Fox Corporation",
    "domain": "foxcorp.com",
    "job_links": []
  },
  {
    "company": "Exotel",
    "domain": "exotel.com",
    "job_links": []
  },
  {
    "company": "Recro",
    "domain": "recro.io",
    "job_links": []
  },
  {
    "company": "Whitefield Careers",
    "domain": "whitefieldcareers.com",
    "job_links": []
  },
  {
    "company": "PayU",
    "domain": "payu.com",
    "job_links": []
  },
  {
    "company": "Rempact",
    "domain": "rempact.com",
    "job_links": []
  },
  {
    "company": "Weekday AI",
    "domain": "weekday.ai",
    "job_links": []
  },
  {
    "company": "Hiver",
    "domain": "hiver.com",
    "job_links": []
  },
  {
    "company": "Enterprise Bot",
    "domain": "enterprisebot.com",
    "job_links": []
  },
  {
    "company": "Mopid",
    "domain": "mopid.com",
    "job_links": []
  },
  {
    "company": "Black Duck",
    "domain": "blackduck.com",
    "job_links": []
  },
  {
    "company": "HDFC Bank",
    "domain": "hdfcbank.com",
    "job_links": []
  },
  {
    "company": "JioStar",
    "domain": "jiostar.com",
    "job_links": []
  }
];

// Known ATS board mappings for companies
const COMPANY_ATS_MAPPING: Record<string, { source: string; handle: string }> = {
  // Greenhouse companies
  'cloudflare.com': { source: 'greenhouse', handle: 'cloudflare' },
  'groupon.com': { source: 'greenhouse', handle: 'groupon' },
  'paypay.ne.jp': { source: 'greenhouse', handle: 'pay2dc' },
  'aiprise.com': { source: 'greenhouse', handle: 'aiprise' },
  'stripe.com': { source: 'greenhouse', handle: 'stripe' },
  'airbnb.com': { source: 'greenhouse', handle: 'airbnb' },
  'datadoghq.com': { source: 'greenhouse', handle: 'datadog' },
  'shopify.com': { source: 'greenhouse', handle: 'shopify' },
  'doordash.com': { source: 'greenhouse', handle: 'doordash' },
  'n26.com': { source: 'greenhouse', handle: 'n26' },
  'wise.com': { source: 'greenhouse', handle: 'wise' },
  'revolut.com': { source: 'greenhouse', handle: 'revolut' },
  'kula.ai': { source: 'greenhouse', handle: 'kula' },
  'abnormalsecurity.com': { source: 'greenhouse', handle: 'abnormal' },
  'gitlab.com': { source: 'careers-page', handle: 'gitlab.com' },
  
  // Lever companies
  'uber.com': { source: 'lever', handle: 'uber' },
  'spotify.com': { source: 'lever', handle: 'spotify' },
  'netflix.com': { source: 'lever', handle: 'netflix' },
  'figma.com': { source: 'lever', handle: 'figma' },
  'dropbox.com': { source: 'lever', handle: 'dropbox' },
  'plaid.com': { source: 'lever', handle: 'plaid' },
  'coinbase.com': { source: 'lever', handle: 'coinbase' },
  'notion.so': { source: 'lever', handle: 'notion' },
  'slack.com': { source: 'lever', handle: 'slack' },
  'robinhood.com': { source: 'lever', handle: 'robinhood' },
  
  // Ashby companies
  'linear.app': { source: 'ashby', handle: 'linear' },
  'raycast.com': { source: 'ashby', handle: 'raycast' },
  'vercel.com': { source: 'ashby', handle: 'vercel' },
  'mercury.com': { source: 'ashby', handle: 'mercury' },
  'brex.com': { source: 'ashby', handle: 'brex' },
  'ramp.com': { source: 'ashby', handle: 'ramp' },
  'rippling.com': { source: 'ashby', handle: 'rippling' },
  'replit.com': { source: 'ashby', handle: 'replit' },
  'deel.com': { source: 'ashby', handle: 'deel' },
  'remote.com': { source: 'ashby', handle: 'remote' },
  
  // Workable companies
  'wework.com': { source: 'workable', handle: 'wework' },
  'typeform.com': { source: 'workable', handle: 'typeform' },
  'transferwise.com': { source: 'workable', handle: 'wise' },
  
  // Additional mappings for new companies
  'glean.com': { source: 'greenhouse', handle: 'glean' },
  'exotel.com': { source: 'greenhouse', handle: 'exotel' },
  'payu.com': { source: 'greenhouse', handle: 'payu' },
  'hiver.com': { source: 'greenhouse', handle: 'hiver' },
  'recro.io': { source: 'greenhouse', handle: 'recro' },
  'foxcorp.com': { source: 'greenhouse', handle: 'fox' },
  'jiostar.com': { source: 'greenhouse', handle: 'jiostar' },
  'blackduck.com': { source: 'greenhouse', handle: 'blackduck' },
  'enterprisebot.com': { source: 'greenhouse', handle: 'enterprisebot' },
};

async function determineSource(domain: string): Promise<string> {
  // Check known mappings first
  if (COMPANY_ATS_MAPPING[domain]) {
    return COMPANY_ATS_MAPPING[domain].source;
  }
  
  // Check if any job links suggest a specific ATS
  const allLinks = companies.find(c => c.domain === domain)?.job_links || [];
  
  for (const link of allLinks) {
    if (link.includes('greenhouse.io')) return 'greenhouse';
    if (link.includes('lever.co')) return 'lever';
    if (link.includes('ashby')) return 'ashby';
    if (link.includes('workable.com')) return 'workable';
    if (link.includes('myworkdayjobs.com')) return 'workday';
  }
  
  // Default to careers-page for companies without known ATS
  return 'careers-page';
}

async function determineHandle(domain: string, jobLinks: string[]): Promise<string> {
  // Check known mappings first
  if (COMPANY_ATS_MAPPING[domain]) {
    return COMPANY_ATS_MAPPING[domain].handle;
  }
  
  // Try to extract board handle from job links
  for (const link of jobLinks) {
    // Greenhouse: https://job-boards.greenhouse.io/[handle]/jobs/...
    const greenhouseMatch = link.match(/greenhouse\.io\/([^\/]+)/);
    if (greenhouseMatch) return greenhouseMatch[1];
    
    // Lever: https://jobs.lever.co/[handle]/...
    const leverMatch = link.match(/lever\.co\/([^\/]+)/);
    if (leverMatch) return leverMatch[1];
    
    // Ashby: https://jobs.ashbyhq.com/[handle]/...
    const ashbyMatch = link.match(/ashbyhq\.com\/([^\/]+)/);
    if (ashbyMatch) return ashbyMatch[1];
    
    // Workable: https://...[handle].workable.com/...
    const workableMatch = link.match(/([^\.]+)\.workable\.com/);
    if (workableMatch) return workableMatch[1];
  }
  
  // Default to domain for careers-page
  return domain;
}

async function main() {
  console.log('Adding new companies to database with correct ATS mappings...');
  
  let processed = 0;
  let errors = 0;
  
  for (const companyData of companies) {
    try {
      const source = await determineSource(companyData.domain);
      const handle = await determineHandle(companyData.domain, companyData.job_links);
      
      await prisma.company.upsert({
        where: {
          source_handle: {
            source,
            handle
          }
        },
        create: {
          name: companyData.company,
          source,
          handle,
          enabled: true
        },
        update: {
          name: companyData.company,
          enabled: true
        }
      });
      
      console.log(`✓ ${companyData.company} (${source}/${handle})`);
      processed++;
    } catch (error) {
      console.error(`✗ ${companyData.company}: ${error}`);
      errors++;
    }
  }
  
  console.log(`\nDone! Processed: ${processed}, Errors: ${errors}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());