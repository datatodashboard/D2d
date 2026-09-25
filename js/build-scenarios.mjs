import fs from 'node:fs';

const domains = [
  {domain:'Banking',prefix:'BAN',master:['customers','customer_id','customer_name'],catalog:['account_products','product_id','product_name'],record:['accounts','account_id','customer_id','product_id','open_date','balance'],event:['transactions','transaction_id','account_id','transaction_date','transaction_type'],categories:['Savings','Current','Salary','NRI','Student','Business'],types:['Credit','Debit','Transfer','Fee'],names:['Arun','Meena','Divya','Karthik','Nila','Vijay','Asha','Rahul']},
  {domain:'Healthcare',prefix:'HEA',master:['patients','patient_id','patient_name'],catalog:['doctors','doctor_id','doctor_name'],record:['appointments','appointment_id','patient_id','doctor_id','appointment_date','bill_amount'],event:['visits','visit_id','appointment_id','visit_date','visit_type'],categories:['Cardiology','Orthopedics','Dermatology','Pediatrics','Neurology','General'],types:['Consultation','Review','Procedure','Emergency'],names:['Ravi','Meena','John','Asha','Bharathi','Sahana','Anu','Kavin']},
  {domain:'Insurance',prefix:'INS',master:['customers','customer_id','customer_name'],catalog:['insurance_products','product_id','product_name'],record:['policies','policy_id','customer_id','product_id','start_date','premium_amount'],event:['claims','claim_id','policy_id','claim_date','claim_type'],categories:['Health','Vehicle','Life','Travel','Home','Business'],types:['Medical','Accident','Theft','Damage'],names:['Arun','Meena','Divya','Karthik','Nila','Vijay','Asha','Rahul']},
  {domain:'Capital Markets',prefix:'CAP',master:['investors','investor_id','investor_name'],catalog:['securities','security_id','security_name'],record:['holdings','holding_id','investor_id','security_id','acquired_date','market_value'],event:['trades','trade_id','holding_id','trade_date','trade_type'],categories:['Equity','Bond','ETF','REIT','Commodity','Fund'],types:['Buy','Sell','Dividend','Split'],names:['Aarav','Diya','Ishaan','Mira','Kabir','Tara','Rohan','Leela']},
  {domain:'Semiconductor',prefix:'SEM',master:['clients','client_id','client_name'],catalog:['chip_products','product_id','product_name'],record:['production_batches','batch_id','client_id','product_id','production_date','batch_cost'],event:['test_results','test_id','batch_id','test_date','test_type'],categories:['MCU','Memory','Sensor','Power','RF','Processor'],types:['Functional','Thermal','Voltage','Reliability'],names:['Orion Systems','Nova Devices','Vertex Labs','Apex Mobility','Delta Controls','Zenith Tech','Pixel Works','Quantum Auto']},
  {domain:'Education',prefix:'EDU',master:['students','student_id','student_name'],catalog:['courses','course_id','course_name'],record:['enrollments','enrollment_id','student_id','course_id','enrollment_date','course_fee'],event:['assessments','assessment_id','enrollment_id','assessment_date','assessment_type'],categories:['SQL','Python','Databricks','Power BI','Data Modeling','Cloud'],types:['Quiz','Assignment','Project','Exam'],names:['Bharathi','Sahana','Anu','Kavin','Priya','Rahul','Meera','Vikram']},
  {domain:'Retail',prefix:'RET',master:['customers','customer_id','customer_name'],catalog:['products','product_id','product_name'],record:['orders','order_id','customer_id','product_id','order_date','order_total'],event:['order_items','order_item_id','order_id','item_date','item_type'],categories:['Electronics','Grocery','Fashion','Home','Books','Sports'],types:['Sale','Return','Exchange','Discount'],names:['Arun','Meena','Divya','Karthik','Nila','Vijay','Asha','Rahul']},
];

const cities=['Chennai','Madurai','Bengaluru','Coimbatore','Salem','Hyderabad','Mumbai','Pune'];
const segments=['Premium','Standard','Enterprise','Student'];
const recordStatuses=['Active','Pending','Closed','Active','Active','Pending','Closed'];
const eventStatuses=['Completed','Pending','Failed','Completed','Completed'];
const recordAmounts=[12000,25000,50000,75000,100000,150000,8000,42000,68000,91000,30000,54000,110000,18000];
const eventAmounts=[500,1200,2500,5000,7500,10000,15000,22000,3000,8500,12500,18000,27000,4200,6800,9400,16000,21000,33000,2800,5600,11200,14500,26000,3900,7200,13500,19500];
const recordDates=['2025-01-10','2025-02-14','2025-03-20','2025-05-05','2025-07-18','2025-09-01','2025-11-22','2026-01-15','2026-02-10','2026-03-12','2026-04-25','2026-05-30','2026-07-08','2026-08-19'];
const eventDates=['2025-01-15','2025-01-30','2025-02-20','2025-03-02','2025-03-21','2025-04-12','2025-05-18','2025-06-05','2025-07-19','2025-08-22','2025-09-10','2025-10-03','2025-11-28','2025-12-17','2026-01-18','2026-02-12','2026-03-14','2026-04-28','2026-05-11','2026-05-31','2026-06-20','2026-07-10','2026-07-25','2026-08-21','2026-08-30','2026-09-03','2026-09-08','2026-09-12'];

const q=s=>`'${String(s).replaceAll("'","''")}'`;
const words=s=>s.replaceAll('_',' ');
const pattern=s=>`\\b${s.replaceAll('_','[ _]')}\\b`;

function asset(d) {
  const [m,mid,mname]=d.master,[c,cid,cname]=d.catalog,[r,rid,rmid,rcid,rdate,ramount]=d.record,[e,eid,erid,edate,etype]=d.event;
  const schema=`CREATE TABLE ${m} (${mid} INT PRIMARY KEY, ${mname} VARCHAR(100), city VARCHAR(50), segment VARCHAR(30), joined_date DATE);
CREATE TABLE ${c} (${cid} INT PRIMARY KEY, ${cname} VARCHAR(100), category VARCHAR(50), status VARCHAR(30), base_value NUMERIC(14,2));
CREATE TABLE ${r} (${rid} INT PRIMARY KEY, ${rmid} INT REFERENCES ${m}(${mid}), ${rcid} INT REFERENCES ${c}(${cid}), ${rdate} DATE, status VARCHAR(30), ${ramount} NUMERIC(14,2));
CREATE TABLE ${e} (${eid} INT PRIMARY KEY, ${erid} INT REFERENCES ${r}(${rid}), ${edate} DATE, ${etype} VARCHAR(40), quantity INT, amount NUMERIC(14,2), status VARCHAR(30));`;
  const masterRows=d.names.map((name,i)=>`(${i+1},${q(name)},${q(cities[i])},${q(segments[i%segments.length])},${q(`202${4+(i%2)}-${String((i%9)+1).padStart(2,'0')}-01`)})`).join(',\n');
  const catalogRows=d.categories.map((category,i)=>`(${101+i},${q(`${category} ${d.domain==='Semiconductor'?'Chip':d.domain==='Education'?'Course':d.domain==='Healthcare'?'Specialist':'Plan'}`)},${q(category)},${q(i===4?'Inactive':'Active')},${5000+(i*7500)})`).join(',\n');
  const recordRows=recordAmounts.map((amount,i)=>`(${1001+i},${(i%8)+1},${101+(i%6)},${q(recordDates[i])},${q(recordStatuses[i%recordStatuses.length])},${amount})`).join(',\n');
  const eventRows=eventAmounts.map((amount,i)=>`(${5001+i},${1001+(i%14)},${q(eventDates[i])},${q(d.types[i%d.types.length])},${(i%5)+1},${amount},${q(eventStatuses[i%eventStatuses.length])})`).join(',\n');
  const sample=`INSERT INTO ${m} (${mid},${mname},city,segment,joined_date) VALUES\n${masterRows};
INSERT INTO ${c} (${cid},${cname},category,status,base_value) VALUES\n${catalogRows};
INSERT INTO ${r} (${rid},${rmid},${rcid},${rdate},status,${ramount}) VALUES\n${recordRows};
INSERT INTO ${e} (${eid},${erid},${edate},${etype},quantity,amount,status) VALUES\n${eventRows};`;
  const schemaText=`${m}(${mid} PK, ${mname}, city, segment, joined_date); ${c}(${cid} PK, ${cname}, category, status, base_value); ${r}(${rid} PK, ${rmid} FK, ${rcid} FK, ${rdate}, status, ${ramount}); ${e}(${eid} PK, ${erid} FK, ${edate}, ${etype}, quantity, amount, status)`;
  return {schema,sample,schemaText};
}

function step(label,groups,example,forbidden=[]) {return {label,groups,example,forbidden};}
function authoredRule(rule) {
  const normalized=rule.example.toLowerCase().replaceAll('_',' ');
  const groups=rule.groups.filter(group=>new RegExp(group,'i').test(normalized));
  return {...rule,groups:groups.length?groups:rule.groups};
}

function makeScenario(d,level,index,spec,schemaText) {
  const code={Beginner:'BEG',Intermediate:'INT',Expert:'EXP'}[level];
  const id=`${d.prefix}_${code}_${String(index).padStart(3,'0')}`;
  const tables=[...new Set(spec.tables)];
  const focus=spec.focus||tables[0];
  const sourceExample=`I will use the ${tables.map(words).join(' and ')} tables and link their keys where needed.`;
  const goalExample=`I need to ${spec.question.charAt(0).toLowerCase()+spec.question.slice(1).replace(/\.$/,'')}.`;
  const checkExample=`I will check the returned rows, column values, duplicates and boundary conditions against the requested result.`;
  const goal=authoredRule({label:'Explain the requested business result in your own words.',groups:['find|return|show|list|identify|count|calculate|report|rank|classify|compare|need|want|determine',pattern(focus)],example:goalExample,forbidden:[]});
  const sources=authoredRule({label:'Name the source tables and how you will use them.',groups:tables.map(pattern),example:sourceExample,forbidden:[]});
  const steps=spec.steps.map(authoredRule);
  const check=authoredRule({label:'Describe the output shape and a check you would perform.',groups:['row|record|column|total|value|result|rank','check|verify|expect|ensure|confirm'],example:checkExample,forbidden:[]});

  // Extract relevant columns from SQL
  const colMatches = spec.sql.match(/\b([a-z_][a-z0-9_]*)\b/gi) || [];
  const relevantCols = [...new Set(colMatches.filter(w => !['select', 'from', 'where', 'and', 'or', 'in', 'between', 'as', 'order', 'by', 'desc', 'asc', 'limit', 'distinct', 'count', 'avg', 'sum', 'max', 'min', 'case', 'when', 'then', 'else', 'end', 'date', 'join', 'left', 'group', 'having', 'null', 'is'].includes(w.toLowerCase())))];

  // Build variants
  const variants = (spec.variants || []).map((v, vIdx) => ({
    variantId: `${id}_v${vIdx + 1}`,
    question: v.question,
    sql: v.sql.trim(),
    tables: [...new Set(v.tables || tables)],
    requiredTables: [...new Set(v.tables || tables)],
    relevantColumns: v.relevantColumns || relevantCols,
    concepts: v.concepts || spec.concepts || ['sql', 'query']
  }));

  // If no variants provided, ensure canonical is variant 1
  if (variants.length === 0) {
    variants.push({
      variantId: `${id}_v1`,
      question: spec.question,
      sql: spec.sql.trim(),
      tables,
      requiredTables: tables,
      relevantColumns: relevantCols,
      concepts: spec.concepts || ['sql', 'query']
    });
  }

  return {
    id,
    domain: d.domain,
    level,
    questionNo: index,
    skill: spec.skill || 'SQL Querying',
    skillIndex: index,
    difficulty: level === 'Beginner' ? 1 : level === 'Intermediate' ? 2 : 3,
    requiredTables: tables,
    relevantColumns: relevantCols,
    concepts: spec.concepts || ['sql', 'query'],
    thinkingExpectations: spec.thinkingExpectations || [
      `Identify target table(s): ${tables.join(', ')}`,
      'Describe the filter or transformation logic'
    ],
    question: spec.question,
    pseudo: steps.map(x=>x.example).join(' '),
    sql: spec.sql.trim(),
    schemaText,
    tables,
    variants,
    evaluation: {ordered:!!spec.ordered},
    rubric: {goal,sources,steps,check},
    exampleThinking: {goal:goalExample,sources:sourceExample,steps:steps.map(x=>x.example).join(' '),check:checkExample}
  };
}

function beginnerSpecsForDomain(d) {
  const [m,mid,mname]=d.master,[c,cid,cname]=d.catalog,[r,rid,rmid,rcid,rdate,ramount]=d.record,[e,eid,erid,edate,etype]=d.event;
  const active='Active',type=d.types[0];
  const S=(label,groups,example)=>step(label,groups,example);

  // Domain-specific business narratives
  let q1, q2, q3, q4, q5, q6, q7, q8, q9, q10, q11, q12, q13, q14, q15, q16, q17, q18, q19, q20;

  if (d.domain === 'Healthcare') {
    q1 = "Return appointments with status Active."; // Exact for HEA_BEG_001 regression tests!
    q2 = "Find appointments where bill amount exceeds 50000 for medical insurance pre-authorization.";
    q3 = "List registered clinic patients residing in Chennai for regional health outreach.";
    q4 = "Count total patient appointments recorded in the clinic system.";
    q5 = "Show clinic appointments ranked from highest to lowest bill amount.";
    q6 = "List distinct medical specialties offered across the clinic doctors catalog.";
    q7 = "Find patient appointments scheduled on or after 1 January 2026.";
    q8 = "Find patient visits conducted for Consultation.";
    q9 = "Return the first five registered patients ordered by patient ID.";
    q10 = "Find appointments with billing amounts between 25000 and 75000 for standard claims processing.";
    q11 = "Find patients whose name starts with A for medical chart filing.";
    q12 = "Retrieve appointments that are either Active or Pending doctor confirmation.";
    q13 = "List healthcare patients enrolled in the Premium health plan tier.";
    q14 = "Find hospital visits recorded between 1 January and 30 June 2026.";
    q15 = "Calculate the average billing amount across all hospital appointments.";
    q16 = "Find the largest single visit charge amount recorded in visits.";
    q17 = "Count distinct patient cities represented in the clinic network.";
    q18 = "Return completed patient visits to archive finalized clinical notes.";
    q19 = "Classify appointments into High, Medium, or Low expense tiers using bill amount.";
    q20 = "Find Active clinic appointments with billing of at least 50000 requiring senior physician sign-off.";
  } else if (d.domain === 'Banking') {
    q1 = "Identify active customer accounts for quarterly interest calculation.";
    q2 = "Find high-balance customer accounts with a balance greater than 50000 for wealth advisory services.";
    q3 = "List bank customers located in Chennai to target local branch promotions.";
    q4 = "Count all customer accounts registered in the core banking system.";
    q5 = "Show customer accounts sorted from highest to lowest balance.";
    q6 = "List distinct account product categories available in the banking portfolio.";
    q7 = "Find customer accounts opened on or after 1 January 2026 for new financial year tracking.";
    q8 = "Find banking transactions of type Credit to audit cash deposits.";
    q9 = "Return the first five registered customers by customer ID for audit sampling.";
    q10 = "Find accounts with balances between 25000 and 75000 for retail tier assessment.";
    q11 = "Find bank customers whose name starts with A for directory indexing.";
    q12 = "Return customer accounts that are either Active or Pending verification.";
    q13 = "List bank customers categorized in the Premium customer segment.";
    q14 = "Find transaction records posted between 1 January and 30 June 2026.";
    q15 = "Calculate the average account balance across all retail banking accounts.";
    q16 = "Find the largest single transaction amount processed in transactions.";
    q17 = "Count distinct customer branch cities represented in the banking ledger.";
    q18 = "Return settled transactions with status Completed for ledger reconciliation.";
    q19 = "Classify accounts into High, Medium, or Low balance tiers based on account balance.";
    q20 = "Find Active customer accounts with a balance of at least 50000 eligible for premium debit card benefits.";
  } else if (d.domain === 'Insurance') {
    q1 = "Retrieve all active insurance policies to confirm current policyholder coverage.";
    q2 = "Find high-premium policies with premium amount greater than 50000 for underwriting risk review.";
    q3 = "List policyholder clients based in Chennai to assess regional claim exposure.";
    q4 = "Count all insurance policies issued by the underwriting division.";
    q5 = "Show insurance policies ordered from highest to lowest premium amount.";
    q6 = "List distinct insurance plan categories available in the insurance products catalog.";
    q7 = "Find insurance policies starting on or after 1 January 2026.";
    q8 = "Find policy claims filed for Medical incidents.";
    q9 = "Return the first five insured clients sorted by customer ID.";
    q10 = "Find policies with premium amounts between 25000 and 75000 for mid-market rate benchmarking.";
    q11 = "Find policyholders whose name starts with A for client file lookup.";
    q12 = "Return insurance policies that are either Active or Pending underwriter approval.";
    q13 = "List insured clients enrolled in the Premium insurance tier.";
    q14 = "Find insurance claims filed between 1 January and 30 June 2026.";
    q15 = "Calculate the average annual premium amount across all issued policies.";
    q16 = "Find the maximum claim payout amount recorded in claims.";
    q17 = "Count distinct policyholder cities covered across the insurance network.";
    q18 = "Return resolved claims with status Completed for actuarial loss reporting.";
    q19 = "Classify insurance policies into High, Medium, or Low premium tiers using premium amount.";
    q20 = "Find Active insurance policies with a premium of at least 50000 for reinsurer treaty reporting.";
  } else if (d.domain === 'Capital Markets') {
    q1 = "Identify active portfolio holdings to monitor investor asset allocations.";
    q2 = "Find high-value portfolio holdings where market value exceeds 50000 for margin exposure monitoring.";
    q3 = "List accredited investors based in Chennai for local investor conference invitations.";
    q4 = "Count total investment holdings tracked across investor portfolios.";
    q5 = "Show portfolio holdings sorted from highest to lowest market value.";
    q6 = "List distinct asset classes and security categories traded on the exchange.";
    q7 = "Find securities holdings acquired on or after 1 January 2026.";
    q8 = "Find executed market trades of trade type Buy to evaluate buy-side liquidity.";
    q9 = "Return the first five registered investors by investor ID for compliance screening.";
    q10 = "Find holdings with market values between 25000 and 75000 for core position rebalancing.";
    q11 = "Find investors whose name starts with A for desk account lookup.";
    q12 = "Return portfolio holdings that are either Active or Pending settlement.";
    q13 = "List investors categorized in the Premium institutional tier.";
    q14 = "Find trading transactions executed between 1 January and 30 June 2026.";
    q15 = "Calculate the average market value across all portfolio holdings.";
    q16 = "Find the largest single trade execution amount in trades.";
    q17 = "Count distinct investor domicile cities represented in the brokerage ledger.";
    q18 = "Return cleared trades with status Completed for depository clearing.";
    q19 = "Classify holdings into High, Medium, or Low value tranches using market value.";
    q20 = "Find Active holdings with a market value of at least 50000 to identify top collateral assets.";
  } else if (d.domain === 'Semiconductor') {
    q1 = "Monitor active semiconductor wafer batches currently in fabrication.";
    q2 = "Identify high-cost fabrication runs where batch cost is greater than 50000 for yield efficiency review.";
    q3 = "List OEM hardware clients located in Chennai receiving direct silicon shipments.";
    q4 = "Count total wafer production batches processed in the fabrication facility.";
    q5 = "Show wafer batches sorted from highest to lowest production batch cost.";
    q6 = "List distinct chip architecture categories available in the chip products catalog.";
    q7 = "Find production batches manufactured on or after 1 January 2026 for process node verification.";
    q8 = "Find wafer quality test results evaluating Functional test characteristics.";
    q9 = "Return the first five semiconductor clients ordered by client ID.";
    q10 = "Find production batches with manufacturing costs between 25000 and 75000 for standard run auditing.";
    q11 = "Find client tech firms whose name starts with A for supplier contract review.";
    q12 = "Return fabrication batches that are either Active or Pending cleanroom inspection.";
    q13 = "List semiconductor clients in the Premium tier receiving dedicated fab capacity.";
    q14 = "Find wafer test inspections conducted between 1 January and 30 June 2026.";
    q15 = "Calculate the average production batch cost across all wafer lots.";
    q16 = "Find the maximum test measurement or cost amount recorded in test results.";
    q17 = "Count distinct client manufacturing hub cities represented in the client directory.";
    q18 = "Return passed test inspections with status Completed for quality assurance release.";
    q19 = "Classify fabrication batches into High, Medium, or Low cost brackets using batch cost.";
    q20 = "Find Active production batches with a cost of at least 50000 for cleanroom priority expediting.";
  } else if (d.domain === 'Education') {
    q1 = "List all active student course enrollments for current semester tracking.";
    q2 = "Find premium course enrollments where course fee exceeds 50000 for department revenue allocation.";
    q3 = "List enrolled students residing in Chennai to coordinate regional campus workshops.";
    q4 = "Count total student course enrollments recorded in the university registrar.";
    q5 = "Show course enrollments sorted from highest to lowest course tuition fee.";
    q6 = "List distinct subject disciplines and course categories offered in the curriculum catalog.";
    q7 = "Find student enrollments registered on or after 1 January 2026 for spring semester intake.";
    q8 = "Find academic assessment records administered as a Quiz.";
    q9 = "Return the first five registered students by student ID for matriculation verification.";
    q10 = "Find enrollments with course fees between 25000 and 75000 for tuition assistance evaluation.";
    q11 = "Find students whose name starts with A for alphabetical roster compilation.";
    q12 = "Return student enrollments that are either Active or Pending prerequisite verification.";
    q13 = "List university students categorized in the Premium scholarship honors segment.";
    q14 = "Find student assessments administered between 1 January and 30 June 2026.";
    q15 = "Calculate the average tuition course fee across all student enrollments.";
    q16 = "Find the highest assessment score or points value recorded in assessments.";
    q17 = "Count distinct hometown cities represented by the enrolled student body.";
    q18 = "Return graded assessments with status Completed to finalize semester grade reports.";
    q19 = "Classify student enrollments into High, Medium, or Low fee bands using course fee.";
    q20 = "Find Active course enrollments with course fees of at least 50000 eligible for installment payment plans.";
  } else {
    // Retail
    q1 = "Filter open customer orders with Active fulfillment status.";
    q2 = "Find high-value customer orders where order total is greater than 50000 for VIP courier delivery.";
    q3 = "List retail shoppers located in Chennai for regional warehouse delivery routing.";
    q4 = "Count total retail customer orders placed through the e-commerce store.";
    q5 = "Show customer orders sorted from highest to lowest order total.";
    q6 = "List distinct product merchandise categories sold across the retail store catalog.";
    q7 = "Find retail orders placed on or after 1 January 2026.";
    q8 = "Find order item transactions categorized as Sale.";
    q9 = "Return the first five registered shoppers by customer ID.";
    q10 = "Find orders with order totals between 25000 and 75000 for commercial bulk discount eligibility.";
    q11 = "Find retail customers whose name starts with A for loyalty program search.";
    q12 = "Return customer orders that are either Active or Pending payment verification.";
    q13 = "List retail shoppers in the Premium VIP loyalty tier.";
    q14 = "Find order items purchased between 1 January and 30 June 2026.";
    q15 = "Calculate the average order value across all retail orders.";
    q16 = "Find the largest single line item purchase amount recorded in order items.";
    q17 = "Count distinct customer shipping cities represented in the order history.";
    q18 = "Return fulfilled orders with status Completed for monthly revenue accounting.";
    q19 = "Classify customer orders into High, Medium, or Low value tiers using order total.";
    q20 = "Find Active customer orders with an order total of at least 50000 requiring management dispatch sign-off.";
  }

  return [
    {
      skill: 'Simple text filtering',
      concepts: ['filter', 'where', 'text condition', 'status'],
      question: q1,
      tables: [r],
      focus: r,
      sql: `SELECT * FROM ${r} WHERE status = '${active}';`,
      steps: [S('Apply the required status filter.', ['status', active], `I will keep only ${words(r)} whose status is ${active}.`)],
      variants: [
        { question: q1, sql: `SELECT * FROM ${r} WHERE status = '${active}';`, tables: [r] },
        { question: `Find pending ${words(r)} awaiting confirmation.`, sql: `SELECT * FROM ${r} WHERE status = 'Pending';`, tables: [r] },
        { question: `List active items from the ${words(c)} catalog.`, sql: `SELECT * FROM ${c} WHERE status = 'Active';`, tables: [c] }
      ]
    },
    {
      skill: 'Numeric filtering',
      concepts: ['numeric comparison', 'where', 'greater than'],
      question: q2,
      tables: [r],
      focus: r,
      sql: `SELECT * FROM ${r} WHERE ${ramount} > 50000;`,
      steps: [S('Apply the numeric threshold.', [pattern(ramount), 'greater|above|>', '50000|50,000'], `I will filter ${words(r)} where ${words(ramount)} is greater than 50000.`)],
      variants: [
        { question: q2, sql: `SELECT * FROM ${r} WHERE ${ramount} > 50000;`, tables: [r] },
        { question: `Find ${words(r)} where ${ramount} exceeds 25000 for standard auditing.`, sql: `SELECT * FROM ${r} WHERE ${ramount} > 25000;`, tables: [r] },
        { question: `Find ${words(c)} items where base value is greater than 10000.`, sql: `SELECT * FROM ${c} WHERE base_value > 10000;`, tables: [c] }
      ]
    },
    {
      skill: 'Location filtering',
      concepts: ['filter', 'where', 'city equality'],
      question: q3,
      tables: [m],
      focus: m,
      sql: `SELECT * FROM ${m} WHERE city = 'Chennai';`,
      steps: [S('Filter by the requested city.', ['city', 'Chennai'], `I will keep ${words(m)} whose city is Chennai.`)],
      variants: [
        { question: q3, sql: `SELECT * FROM ${m} WHERE city = 'Chennai';`, tables: [m] },
        { question: `List ${words(m)} located in Bengaluru for southern regional operations.`, sql: `SELECT * FROM ${m} WHERE city = 'Bengaluru';`, tables: [m] },
        { question: `List ${words(m)} based in Mumbai for commercial territory management.`, sql: `SELECT * FROM ${m} WHERE city = 'Mumbai';`, tables: [m] }
      ]
    },
    {
      skill: 'COUNT',
      concepts: ['count aggregation', 'total records'],
      question: q4,
      tables: [r],
      focus: r,
      sql: `SELECT COUNT(*) AS total_records FROM ${r};`,
      steps: [S('Use a count aggregation.', ['count', 'row|record'], `I will count every row in the ${words(r)} table.`)],
      variants: [
        { question: q4, sql: `SELECT COUNT(*) AS total_records FROM ${r};`, tables: [r] },
        { question: `Count all recorded events in ${words(e)}.`, sql: `SELECT COUNT(*) AS total_records FROM ${e};`, tables: [e] },
        { question: `Count total registered entities in ${words(m)}.`, sql: `SELECT COUNT(*) AS total_records FROM ${m};`, tables: [m] }
      ]
    },
    {
      skill: 'ORDER BY',
      concepts: ['sorting', 'order by', 'descending sequence'],
      question: q5,
      tables: [r],
      focus: r,
      sql: `SELECT * FROM ${r} ORDER BY ${ramount} DESC;`,
      ordered: true,
      steps: [S('Sort descending by the requested value.', [pattern(ramount), 'sort|order', 'descending|highest|desc'], `I will order ${words(r)} by ${words(ramount)} from highest to lowest.`)],
      variants: [
        { question: q5, sql: `SELECT * FROM ${r} ORDER BY ${ramount} DESC;`, tables: [r] },
        { question: `Show ${words(r)} in chronological sequence by ${rdate} descending.`, sql: `SELECT * FROM ${r} ORDER BY ${rdate} DESC;`, tables: [r] },
        { question: `List ${words(m)} alphabetically by name from A to Z.`, sql: `SELECT * FROM ${m} ORDER BY ${mname} ASC;`, tables: [m] }
      ]
    },
    {
      skill: 'DISTINCT',
      concepts: ['distinct', 'unique values', 'category projection'],
      question: q6,
      tables: [c],
      focus: c,
      sql: `SELECT DISTINCT category FROM ${c} ORDER BY category;`,
      ordered: true,
      steps: [S('Remove duplicate category values.', ['distinct|unique', 'category'], `I will return distinct category values from ${words(c)}.`)],
      variants: [
        { question: q6, sql: `SELECT DISTINCT category FROM ${c} ORDER BY category;`, tables: [c] },
        { question: `List distinct customer segments represented across ${words(m)}.`, sql: `SELECT DISTINCT segment FROM ${m} ORDER BY segment;`, tables: [m] },
        { question: `List distinct operational statuses present in ${words(r)}.`, sql: `SELECT DISTINCT status FROM ${r} ORDER BY status;`, tables: [r] }
      ]
    },
    {
      skill: 'Date filtering',
      concepts: ['date boundary', 'where', 'date comparison'],
      question: q7,
      tables: [r],
      focus: r,
      sql: `SELECT * FROM ${r} WHERE ${rdate} >= DATE '2026-01-01';`,
      steps: [S('Apply the date boundary.', [pattern(rdate), '2026', 'after|from|>=|on or'], `I will filter ${words(r)} with ${words(rdate)} on or after 1 January 2026.`)],
      variants: [
        { question: q7, sql: `SELECT * FROM ${r} WHERE ${rdate} >= DATE '2026-01-01';`, tables: [r] },
        { question: `Find ${words(r)} created before 1 January 2026 for historical archiving.`, sql: `SELECT * FROM ${r} WHERE ${rdate} < DATE '2026-01-01';`, tables: [r] },
        { question: `Find ${words(m)} registered on or after 1 January 2025.`, sql: `SELECT * FROM ${m} WHERE joined_date >= DATE '2025-01-01';`, tables: [m] }
      ]
    },
    {
      skill: 'Event type filtering',
      concepts: ['filter', 'where', 'event classification'],
      question: q8,
      tables: [e],
      focus: e,
      sql: `SELECT * FROM ${e} WHERE ${etype} = '${type}';`,
      steps: [S('Filter by event type.', [pattern(etype), type], `I will keep ${words(e)} whose ${words(etype)} equals ${type}.`)],
      variants: [
        { question: q8, sql: `SELECT * FROM ${e} WHERE ${etype} = '${type}';`, tables: [e] },
        { question: `Find ${words(e)} with quantity greater than 2.`, sql: `SELECT * FROM ${e} WHERE quantity > 2;`, tables: [e] },
        { question: `Find ${words(e)} where amount exceeds 5000.`, sql: `SELECT * FROM ${e} WHERE amount > 5000;`, tables: [e] }
      ]
    },
    {
      skill: 'LIMIT/TOP',
      concepts: ['limit', 'row count limit', 'deterministic order'],
      question: q9,
      tables: [m],
      focus: m,
      sql: `SELECT * FROM ${m} ORDER BY ${mid} LIMIT 5;`,
      ordered: true,
      steps: [S('Use deterministic ordering and a row limit.', [pattern(mid), 'order|sort', 'limit|first|five|5'], `I will order by ${words(mid)} and limit the result to five rows.`)],
      variants: [
        { question: q9, sql: `SELECT * FROM ${m} ORDER BY ${mid} LIMIT 5;`, tables: [m] },
        { question: `Return the top 3 highest value ${words(r)} by ${ramount}.`, sql: `SELECT * FROM ${r} ORDER BY ${ramount} DESC LIMIT 3;`, tables: [r] },
        { question: `Return the first 5 records in ${words(c)} ordered by ${cid}.`, sql: `SELECT * FROM ${c} ORDER BY ${cid} LIMIT 5;`, tables: [c] }
      ]
    },
    {
      skill: 'Range filtering',
      concepts: ['between', 'numeric range', 'inclusive boundaries'],
      question: q10,
      tables: [r],
      focus: r,
      sql: `SELECT * FROM ${r} WHERE ${ramount} BETWEEN 25000 AND 75000;`,
      steps: [S('Apply an inclusive range.', ['between|range', '25000|25,000', '75000|75,000'], `I will keep ${words(r)} whose ${words(ramount)} is between 25000 and 75000.`)],
      variants: [
        { question: q10, sql: `SELECT * FROM ${r} WHERE ${ramount} BETWEEN 25000 AND 75000;`, tables: [r] },
        { question: `Find ${words(e)} with amount between 1000 and 10000.`, sql: `SELECT * FROM ${e} WHERE amount BETWEEN 1000 AND 10000;`, tables: [e] },
        { question: `Find ${words(c)} items with base value between 5000 and 20000.`, sql: `SELECT * FROM ${c} WHERE base_value BETWEEN 5000 AND 20000;`, tables: [c] }
      ]
    },
    {
      skill: 'Pattern matching',
      concepts: ['like', 'prefix matching', 'wildcard string filter'],
      question: q11,
      tables: [m],
      focus: m,
      sql: `SELECT * FROM ${m} WHERE ${mname} LIKE 'A%';`,
      steps: [S('Apply a prefix pattern.', ['start|prefix|like', 'A'], `I will use a prefix match to keep ${words(m)} names starting with A.`)],
      variants: [
        { question: q11, sql: `SELECT * FROM ${m} WHERE ${mname} LIKE 'A%';`, tables: [m] },
        { question: `Find ${words(m)} whose name starts with M for directory lookups.`, sql: `SELECT * FROM ${m} WHERE ${mname} LIKE 'M%';`, tables: [m] },
        { question: `Find ${words(m)} whose name contains 'a' anywhere.`, sql: `SELECT * FROM ${m} WHERE ${mname} LIKE '%a%';`, tables: [m] }
      ]
    },
    {
      skill: 'Multiple conditions',
      concepts: ['in operator', 'or condition', 'status membership'],
      question: q12,
      tables: [r],
      focus: r,
      sql: `SELECT * FROM ${r} WHERE status IN ('Active','Pending');`,
      steps: [S('Filter for either allowed status.', ['status', 'Active', 'Pending'], `I will keep ${words(r)} when status is either Active or Pending.`)],
      variants: [
        { question: q12, sql: `SELECT * FROM ${r} WHERE status IN ('Active','Pending');`, tables: [r] },
        { question: `Return ${words(m)} residing in either Chennai or Bengaluru.`, sql: `SELECT * FROM ${m} WHERE city IN ('Chennai','Bengaluru');`, tables: [m] },
        { question: `Find ${words(e)} with status in ('Completed','Pending').`, sql: `SELECT * FROM ${e} WHERE status IN ('Completed','Pending');`, tables: [e] }
      ]
    },
    {
      skill: 'Segment filtering',
      concepts: ['where', 'segment filter', 'tier matching'],
      question: q13,
      tables: [m],
      focus: m,
      sql: `SELECT * FROM ${m} WHERE segment = 'Premium';`,
      steps: [S('Filter the requested segment.', ['segment', 'Premium'], `I will filter ${words(m)} to the Premium segment only.`)],
      variants: [
        { question: q13, sql: `SELECT * FROM ${m} WHERE segment = 'Premium';`, tables: [m] },
        { question: `List ${words(m)} belonging to the Standard tier.`, sql: `SELECT * FROM ${m} WHERE segment = 'Standard';`, tables: [m] },
        { question: `List ${words(m)} in the Enterprise account bracket.`, sql: `SELECT * FROM ${m} WHERE segment = 'Enterprise';`, tables: [m] }
      ]
    },
    {
      skill: 'Date range filtering',
      concepts: ['between dates', 'date range', 'temporal window'],
      question: q14,
      tables: [e],
      focus: e,
      sql: `SELECT * FROM ${e} WHERE ${edate} BETWEEN DATE '2026-01-01' AND DATE '2026-06-30';`,
      steps: [S('Apply the requested date range.', [pattern(edate), '2026', 'between|range'], `I will filter ${words(e)} to dates between January and June 2026.`)],
      variants: [
        { question: q14, sql: `SELECT * FROM ${e} WHERE ${edate} BETWEEN DATE '2026-01-01' AND DATE '2026-06-30';`, tables: [e] },
        { question: `Find ${words(r)} created in the year 2025.`, sql: `SELECT * FROM ${r} WHERE ${rdate} BETWEEN DATE '2025-01-01' AND DATE '2025-12-31';`, tables: [r] },
        { question: `Find ${words(e)} dated on or after 1 July 2026.`, sql: `SELECT * FROM ${e} WHERE ${edate} >= DATE '2026-07-01';`, tables: [e] }
      ]
    },
    {
      skill: 'AVG',
      concepts: ['avg aggregation', 'arithmetic mean'],
      question: q15,
      tables: [r],
      focus: r,
      sql: `SELECT AVG(${ramount}) AS average_amount FROM ${r};`,
      steps: [S('Use the average aggregation.', ['average|avg', pattern(ramount)], `I will calculate the average ${words(ramount)} across all ${words(r)}.`)]
    },
    {
      skill: 'MAX',
      concepts: ['max aggregation', 'highest value'],
      question: q16,
      tables: [e],
      focus: e,
      sql: `SELECT MAX(amount) AS largest_amount FROM ${e};`,
      steps: [S('Use a maximum aggregation.', ['maximum|max|largest', 'amount'], `I will use MAX on amount to find the largest event value.`)]
    },
    {
      skill: 'COUNT DISTINCT',
      concepts: ['count distinct', 'unique cardinality'],
      question: q17,
      tables: [m],
      focus: m,
      sql: `SELECT COUNT(DISTINCT city) AS city_count FROM ${m};`,
      steps: [S('Count unique city values.', ['count', 'distinct|unique', 'city'], `I will count the distinct city values in ${words(m)}.`)]
    },
    {
      skill: 'Event status filter',
      concepts: ['where', 'status check', 'completed state'],
      question: q18,
      tables: [e],
      focus: e,
      sql: `SELECT * FROM ${e} WHERE status = 'Completed';`,
      steps: [S('Apply the event status filter.', ['status', 'Completed'], `I will keep ${words(e)} whose status is Completed.`)]
    },
    {
      skill: 'Business analysis scenario',
      concepts: ['case expression', 'conditional classification', 'tier banding'],
      question: q19,
      tables: [r],
      focus: r,
      sql: `SELECT ${rid}, ${ramount}, CASE WHEN ${ramount} >= 100000 THEN 'High' WHEN ${ramount} >= 50000 THEN 'Medium' ELSE 'Low' END AS amount_band FROM ${r} ORDER BY ${rid};`,
      ordered: true,
      steps: [S('Apply all classification boundaries.', ['case|classif|band', pattern(ramount), '100000|100,000', '50000|50,000'], `I will use CASE on ${words(ramount)} with 100000 and 50000 boundaries.`)]
    },
    {
      skill: 'Beginner mini challenge',
      concepts: ['multi-condition', 'and logic', 'status and amount criteria'],
      question: q20,
      tables: [r],
      focus: r,
      sql: `SELECT * FROM ${r} WHERE status = 'Active' AND ${ramount} >= 50000;`,
      steps: [S('Combine status and amount conditions.', ['Active', pattern(ramount), '50000|50,000', 'and|both'], `I will require Active status and ${words(ramount)} of at least 50000.`)]
    }
  ];
}

function specs(d) {
  const [m,mid,mname]=d.master,[c,cid,cname]=d.catalog,[r,rid,rmid,rcid,rdate,ramount]=d.record,[e,eid,erid,edate,etype]=d.event;
  const S=(label,groups,example)=>step(label,groups,example);

  const beginner = beginnerSpecsForDomain(d);

  const intermediate=[
    {skill:'Simple JOIN',concepts:['inner join','foreign key link'],question:`Show each ${words(m)} name with its ${words(r)} details.`,tables:[m,r],focus:m,sql:`SELECT m.${mname}, r.${rid}, r.status, r.${ramount} FROM ${m} m JOIN ${r} r ON m.${mid}=r.${rmid} ORDER BY m.${mid},r.${rid};`,ordered:true,steps:[S('Join master and record rows by their key.',['join|link',pattern(mid),pattern(rmid)],`I will join ${words(m)} to ${words(r)} using ${words(mid)}.`)]},
    {skill:'LEFT JOIN with COUNT',concepts:['left join','group by','count'],question:`Count ${words(r)} for every ${words(c)} item.`,tables:[c,r],focus:c,sql:`SELECT c.${cname}, COUNT(r.${rid}) AS record_count FROM ${c} c LEFT JOIN ${r} r ON c.${cid}=r.${rcid} GROUP BY c.${cid},c.${cname} ORDER BY c.${cid};`,ordered:true,steps:[S('Keep catalogue items even without records.',['left join',pattern(cid),pattern(rcid)],`I will left join ${words(c)} to ${words(r)} by ${words(cid)}.`),S('Group and count records.',['group','count'],`I will group each ${words(c)} item and count matching ${words(r)}.`)]},
    {skill:'Anti-join (IS NULL)',concepts:['anti-join','left join','is null'],question:`Find ${words(r)} that have no ${words(e)}.`,tables:[r,e],focus:r,sql:`SELECT r.${rid} FROM ${r} r LEFT JOIN ${e} e ON r.${rid}=e.${erid} WHERE e.${eid} IS NULL ORDER BY r.${rid};`,ordered:true,steps:[S('Use an anti-join for missing events.',['left join',pattern(rid),pattern(erid),'null|missing|no '],`I will left join ${words(e)} and keep ${words(r)} with a null event key.`)]},
    {skill:'Grouped aggregation',concepts:['join','group by','sum'],question:`Calculate total event amount for each ${words(r)}.`,tables:[r,e],focus:r,sql:`SELECT r.${rid}, COALESCE(SUM(e.amount),0) AS total_amount FROM ${r} r LEFT JOIN ${e} e ON r.${rid}=e.${erid} GROUP BY r.${rid} ORDER BY r.${rid};`,ordered:true,steps:[S('Join records and events.',['join|link',pattern(rid),pattern(erid)],`I will join ${words(r)} to ${words(e)} using ${words(rid)}.`),S('Group and total event amounts.',['group','sum|total','amount'],`I will group by ${words(rid)} and sum event amounts.`)]},
    {skill:'HAVING filter',concepts:['group by','having','threshold'],question:`Find ${words(r)} whose total event amount exceeds 20000.`,tables:[r,e],focus:r,sql:`SELECT r.${rid}, SUM(e.amount) AS total_amount FROM ${r} r JOIN ${e} e ON r.${rid}=e.${erid} GROUP BY r.${rid} HAVING SUM(e.amount)>20000 ORDER BY total_amount DESC;`,ordered:true,steps:[S('Aggregate events per record.',['join|link','group','sum|total'],`I will join and group ${words(e)} for each ${words(r)}.`),S('Filter aggregated totals.',['having','20000|20,000'],`I will use HAVING to keep totals above 20000.`)]},
    {skill:'Dimension grouping',concepts:['join','group by','count'],question:`Count ${words(r)} by ${words(m)} segment.`,tables:[m,r],focus:m,sql:`SELECT m.segment, COUNT(r.${rid}) AS record_count FROM ${m} m LEFT JOIN ${r} r ON m.${mid}=r.${rmid} GROUP BY m.segment ORDER BY m.segment;`,ordered:true,steps:[S('Join records to their master rows.',['join|link',pattern(mid)],`I will link ${words(r)} to ${words(m)} by ${words(mid)}.`),S('Group by segment and count.',['segment','group','count'],`I will group by segment and count the matching records.`)]},
    {skill:'Category averaging',concepts:['join','group by','avg'],question:`Calculate average ${ramount} by ${words(c)} category.`,tables:[c,r],focus:c,sql:`SELECT c.category, AVG(r.${ramount}) AS average_amount FROM ${c} c JOIN ${r} r ON c.${cid}=r.${rcid} GROUP BY c.category ORDER BY c.category;`,ordered:true,steps:[S('Join catalogue and records.',['join|link',pattern(cid)],`I will join ${words(c)} and ${words(r)} by ${words(cid)}.`),S('Average by category.',['average|avg','category','group'],`I will group by category and average ${words(ramount)}.`)]},
    {skill:'Multi-table 3-way JOIN',concepts:['multi-table join','three relations'],question:`Show ${words(m)}, ${words(r)} and ${words(c)} names together.`,tables:[m,r,c],focus:m,sql:`SELECT m.${mname}, r.${rid}, c.${cname}, r.status FROM ${m} m JOIN ${r} r ON m.${mid}=r.${rmid} JOIN ${c} c ON r.${rcid}=c.${cid} ORDER BY r.${rid};`,ordered:true,steps:[S('Join all three related tables.',['join|link',pattern(mid),pattern(cid)],`I will join ${words(m)}, ${words(r)} and ${words(c)} through both foreign keys.`)]},
    {skill:'Master entity aggregation',concepts:['join','group by','sum'],question:`Calculate total ${ramount} for each ${words(m)}.`,tables:[m,r],focus:m,sql:`SELECT m.${mid},m.${mname},SUM(r.${ramount}) AS total_amount FROM ${m} m JOIN ${r} r ON m.${mid}=r.${rmid} GROUP BY m.${mid},m.${mname} ORDER BY total_amount DESC;`,ordered:true,steps:[S('Join and aggregate per master.',['join|link','sum|total','group'],`I will join ${words(r)} and sum ${words(ramount)} for each ${words(m)}.`)]},
    {skill:'Subquery comparison',concepts:['scalar subquery','average comparison'],question:`Find ${words(r)} whose ${ramount} is above the overall average.`,tables:[r],focus:r,sql:`SELECT ${rid},${ramount} FROM ${r} WHERE ${ramount}>(SELECT AVG(${ramount}) FROM ${r}) ORDER BY ${ramount} DESC;`,ordered:true,steps:[S('Compare each value with a subquery average.',['average|avg','subquery|compare|overall',pattern(ramount)],`I will compare each ${words(ramount)} with the overall average from a subquery.`)]},
    {skill:'Parent-child attribute projection',concepts:['join','column projection'],question:`Show ${words(e)} with their parent ${words(r)} status.`,tables:[r,e],focus:e,sql:`SELECT e.${eid},e.${edate},e.${etype},e.amount,r.status AS record_status FROM ${e} e JOIN ${r} r ON e.${erid}=r.${rid} ORDER BY e.${eid};`,ordered:true,steps:[S('Join events to parent records.',['join|link',pattern(erid),pattern(rid)],`I will join ${words(e)} to ${words(r)} using the parent key.`)]},
    {skill:'Conditional aggregation',concepts:['case inside sum','multi-status sum'],question:`Calculate completed and failed event amounts for every ${words(r)}.`,tables:[r,e],focus:r,sql:`SELECT r.${rid},SUM(CASE WHEN e.status='Completed' THEN e.amount ELSE 0 END) AS completed_amount,SUM(CASE WHEN e.status='Failed' THEN e.amount ELSE 0 END) AS failed_amount FROM ${r} r LEFT JOIN ${e} e ON r.${rid}=e.${erid} GROUP BY r.${rid} ORDER BY r.${rid};`,ordered:true,steps:[S('Use conditional aggregation.',['case','Completed','Failed','sum|total'],`I will use CASE inside SUM for Completed and Failed event amounts.`)]},
    {skill:'Date truncation grouping',concepts:['date_trunc','month grouping'],question:`Count ${words(e)} by calendar month.`,tables:[e],focus:e,sql:`SELECT DATE_TRUNC('month',${edate})::date AS event_month,COUNT(*) AS event_count FROM ${e} GROUP BY DATE_TRUNC('month',${edate}) ORDER BY event_month;`,ordered:true,steps:[S('Create and group by month.',['month|date_trunc','group','count'],`I will derive the month, group events and count each month.`)]},
    {skill:'Anti-join master missing records',concepts:['left join','is null'],question:`Find ${words(m)} with no ${words(r)}.`,tables:[m,r],focus:m,sql:`SELECT m.${mid},m.${mname} FROM ${m} m LEFT JOIN ${r} r ON m.${mid}=r.${rmid} WHERE r.${rid} IS NULL ORDER BY m.${mid};`,ordered:true,steps:[S('Use an anti-join for missing records.',['left join','null|missing|no ',pattern(mid)],`I will left join ${words(r)} and keep ${words(m)} with no record key.`)]},
    {skill:'Anti-join catalog unused items',concepts:['left join','is null'],question:`Find ${words(c)} items that are unused by ${words(r)}.`,tables:[c,r],focus:c,sql:`SELECT c.${cid},c.${cname} FROM ${c} c LEFT JOIN ${r} r ON c.${cid}=r.${rcid} WHERE r.${rid} IS NULL ORDER BY c.${cid};`,ordered:true,steps:[S('Use an anti-join for unused catalogue items.',['left join','null|unused|no ',pattern(cid)],`I will left join ${words(r)} and keep ${words(c)} with no matching record.`)]},
    {skill:'MIN date aggregation',concepts:['min date','earliest date'],question:`Find the earliest ${words(r)} date for every ${words(m)}.`,tables:[m,r],focus:m,sql:`SELECT m.${mid},m.${mname},MIN(r.${rdate}) AS first_date FROM ${m} m JOIN ${r} r ON m.${mid}=r.${rmid} GROUP BY m.${mid},m.${mname} ORDER BY m.${mid};`,ordered:true,steps:[S('Join, group and take the earliest date.',['join|link','minimum|min|earliest','group'],`I will join records, group by ${words(m)} and take the minimum date.`)]},
    {skill:'MAX date aggregation',concepts:['max date','latest date'],question:`Find the latest ${words(e)} date for every ${words(r)}.`,tables:[r,e],focus:r,sql:`SELECT r.${rid},MAX(e.${edate}) AS latest_event_date FROM ${r} r LEFT JOIN ${e} e ON r.${rid}=e.${erid} GROUP BY r.${rid} ORDER BY r.${rid};`,ordered:true,steps:[S('Join, group and take the latest date.',['join|link','maximum|max|latest','group'],`I will group events per ${words(r)} and take the maximum date.`)]},
    {skill:'DISTINCT after JOIN',concepts:['join','distinct filter'],question:`List distinct ${words(m)} with at least one completed ${words(e)}.`,tables:[m,r,e],focus:m,sql:`SELECT DISTINCT m.${mid},m.${mname} FROM ${m} m JOIN ${r} r ON m.${mid}=r.${rmid} JOIN ${e} e ON r.${rid}=e.${erid} WHERE e.status='Completed' ORDER BY m.${mid};`,ordered:true,steps:[S('Join through records and filter completed events.',['join|link','Completed','distinct|unique'],`I will join all tables, keep Completed events and remove duplicate ${words(m)}.`)]},
    {skill:'3-table average aggregation',concepts:['three-table join','avg'],question:`Calculate average event amount by ${words(c)} category.`,tables:[c,r,e],focus:c,sql:`SELECT c.category,AVG(e.amount) AS average_event_amount FROM ${c} c JOIN ${r} r ON c.${cid}=r.${rcid} JOIN ${e} e ON r.${rid}=e.${erid} GROUP BY c.category ORDER BY c.category;`,ordered:true,steps:[S('Join catalogue, records and events.',['join|link',pattern(cid),pattern(rid)],`I will join ${words(c)}, ${words(r)} and ${words(e)} through their keys.`),S('Average events by category.',['average|avg','category','group'],`I will group by category and average event amount.`)]},
    {skill:'Two-dimensional GROUP BY',concepts:['group by multiple columns','count'],question:`Count ${words(r)} by master segment and record status.`,tables:[m,r],focus:r,sql:`SELECT m.segment,r.status,COUNT(*) AS record_count FROM ${m} m JOIN ${r} r ON m.${mid}=r.${rmid} GROUP BY m.segment,r.status ORDER BY m.segment,r.status;`,ordered:true,steps:[S('Group on both requested dimensions.',['segment','status','group','count'],`I will join the tables and group counts by segment and status.`)]},
  ];

  const expert=[
    {skill:'Window RANK()',concepts:['cte','rank','window function'],question:`Rank ${words(m)} by total event amount.`,tables:[m,r,e],focus:m,sql:`WITH totals AS (SELECT m.${mid},m.${mname},SUM(e.amount) total_amount FROM ${m} m JOIN ${r} r ON m.${mid}=r.${rmid} JOIN ${e} e ON r.${rid}=e.${erid} GROUP BY m.${mid},m.${mname}) SELECT ${mid},${mname},total_amount,RANK() OVER(ORDER BY total_amount DESC) AS amount_rank FROM totals ORDER BY amount_rank,${mid};`,ordered:true,steps:[S('Aggregate event amounts per master.',['sum|total','group','join|link'],`I will join all tables and total event amounts per ${words(m)}.`),S('Rank the aggregated totals.',['rank','order|descending'],`I will rank the totals from highest to lowest.`)]},
    {skill:'HAVING with date filter',concepts:['left join','having','is null or condition'],question:`Find ${words(r)} whose latest event was before 1 January 2026 or is missing.`,tables:[r,e],focus:r,sql:`SELECT r.${rid},MAX(e.${edate}) AS latest_event_date FROM ${r} r LEFT JOIN ${e} e ON r.${rid}=e.${erid} GROUP BY r.${rid} HAVING MAX(e.${edate})<DATE '2026-01-01' OR MAX(e.${edate}) IS NULL ORDER BY r.${rid};`,ordered:true,steps:[S('Preserve records without events.',['left join','missing|null'],`I will left join events so ${words(r)} without activity remain.`),S('Filter using the grouped latest date.',['maximum|max|latest','having','2026'],`I will group each record and use HAVING on its latest event date.`)]},
    {skill:'CTE with subquery comparison',concepts:['cte','scalar subquery'],question:`Find ${words(m)} whose total ${ramount} is above the average master total.`,tables:[m,r],focus:m,sql:`WITH totals AS (SELECT ${rmid},SUM(${ramount}) total_amount FROM ${r} GROUP BY ${rmid}) SELECT ${rmid},total_amount FROM totals WHERE total_amount>(SELECT AVG(total_amount) FROM totals) ORDER BY total_amount DESC;`,ordered:true,steps:[S('Build totals per master in a CTE.',['cte|with','sum|total','group'],`I will use a CTE to total ${words(ramount)} by master.`),S('Compare totals with their average.',['average|avg','compare|above'],`I will keep master totals above the average total.`)]},
    {skill:'Banded CASE ordering',concepts:['case when','banding'],question:`Classify ${words(r)} into High, Medium and Low amount bands.`,tables:[r],focus:r,sql:`SELECT ${rid},${ramount},CASE WHEN ${ramount}>=100000 THEN 'High' WHEN ${ramount}>=50000 THEN 'Medium' ELSE 'Low' END amount_band FROM ${r} ORDER BY ${rid};`,ordered:true,steps:[S('Apply ordered CASE boundaries.',['case','100000|100,000','50000|50,000'],`I will use CASE with 100000 and 50000 amount boundaries.`)]},
    {skill:'Window LAG() over months',concepts:['cte','lag','window function'],question:`Show month-over-month event amount for every ${words(r)}.`,tables:[e],focus:e,sql:`WITH monthly AS (SELECT ${erid},DATE_TRUNC('month',${edate})::date event_month,SUM(amount) monthly_amount FROM ${e} GROUP BY ${erid},DATE_TRUNC('month',${edate})) SELECT ${erid},event_month,monthly_amount,LAG(monthly_amount) OVER(PARTITION BY ${erid} ORDER BY event_month) previous_month_amount FROM monthly ORDER BY ${erid},event_month;`,ordered:true,steps:[S('Aggregate event amounts by record and month.',['month|date_trunc','sum|total','group'],`I will total event amounts by record and month in a CTE.`),S('Use LAG within each record.',['lag','partition','order'],`I will use LAG partitioned by record and ordered by month.`)]},
    {skill:'Running cumulative SUM()',concepts:['window function','cumulative sum','partition by'],question:`Calculate a running event total within every ${words(r)}.`,tables:[e],focus:e,sql:`SELECT ${erid},${eid},${edate},amount,SUM(amount) OVER(PARTITION BY ${erid} ORDER BY ${edate},${eid}) running_amount FROM ${e} ORDER BY ${erid},${edate},${eid};`,ordered:true,steps:[S('Use an ordered windowed sum.',['sum','over|window','partition','order'],`I will use a windowed SUM partitioned by record and ordered by date.`)]},
    {skill:'ROW_NUMBER() top N per partition',concepts:['cte','row_number','partition by'],question:`Return the two largest ${words(e)} for every ${words(r)}.`,tables:[e],focus:e,sql:`WITH ranked AS (SELECT e.*,ROW_NUMBER() OVER(PARTITION BY ${erid} ORDER BY amount DESC,${eid}) rn FROM ${e} e) SELECT ${eid},${erid},amount FROM ranked WHERE rn<=2 ORDER BY ${erid},rn;`,ordered:true,steps:[S('Rank events within each parent record.',['row_number|row number','partition','amount','descending|desc'],`I will assign row numbers within each record by descending amount.`),S('Keep the top two ranks.',['top|two|2','<=|keep|filter'],`I will keep row numbers one and two for every record.`)]},
    {skill:'Percentage of grand total',concepts:['window sum','ratio calculation'],question:`Calculate each ${words(r)} share of total event amount.`,tables:[r,e],focus:r,sql:`WITH totals AS (SELECT r.${rid},COALESCE(SUM(e.amount),0) total_amount FROM ${r} r LEFT JOIN ${e} e ON r.${rid}=e.${erid} GROUP BY r.${rid}) SELECT ${rid},total_amount,ROUND(100.0*total_amount/NULLIF(SUM(total_amount) OVER(),0),2) percent_of_total FROM totals ORDER BY ${rid};`,ordered:true,steps:[S('Aggregate event totals per record.',['sum|total','group','join|link'],`I will total events for each ${words(r)} in a CTE.`),S('Divide by the grand total.',['percent|share|divide','over|grand total'],`I will divide each record total by the windowed grand total.`)]},
    {skill:'DENSE_RANK() within partition',concepts:['dense_rank','partition by'],question:`Dense-rank ${words(r)} by ${ramount} within each ${words(m)}.`,tables:[r],focus:r,sql:`SELECT ${rmid},${rid},${ramount},DENSE_RANK() OVER(PARTITION BY ${rmid} ORDER BY ${ramount} DESC) amount_rank FROM ${r} ORDER BY ${rmid},amount_rank,${rid};`,ordered:true,steps:[S('Rank within each master without rank gaps.',['dense_rank|dense rank','partition',pattern(rmid),pattern(ramount)],`I will dense rank records within each master by descending amount.`)]},
    {skill:'Sequential LAG() comparison',concepts:['lag','ordered window'],question:`Show each event amount beside the previous event amount.`,tables:[e],focus:e,sql:`SELECT ${erid},${eid},${edate},amount,LAG(amount) OVER(PARTITION BY ${erid} ORDER BY ${edate},${eid}) previous_amount FROM ${e} ORDER BY ${erid},${edate},${eid};`,ordered:true,steps:[S('Use LAG in event sequence.',['lag','partition','order','amount'],`I will use LAG by record ordered by event date and event ID.`)]},
    {skill:'Moving average window frame',concepts:['rows between','moving average'],question:`Calculate a three-event moving average for each ${words(r)}.`,tables:[e],focus:e,sql:`SELECT ${erid},${eid},${edate},amount,AVG(amount) OVER(PARTITION BY ${erid} ORDER BY ${edate},${eid} ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) moving_average FROM ${e} ORDER BY ${erid},${edate},${eid};`,ordered:true,steps:[S('Define a three-row window frame.',['average|avg','2 preceding|three|3','current row','partition'],`I will average the current event and two preceding events within each record.`)]},
    {skill:'EXISTS / NOT EXISTS correlated logic',concepts:['exists','not exists','correlated subquery'],question:`Find ${words(m)} whose every ${words(r)} is Active.`,tables:[m,r],focus:m,sql:`SELECT m.${mid},m.${mname} FROM ${m} m WHERE EXISTS(SELECT 1 FROM ${r} r WHERE r.${rmid}=m.${mid}) AND NOT EXISTS(SELECT 1 FROM ${r} r WHERE r.${rmid}=m.${mid} AND r.status<>'Active') ORDER BY m.${mid};`,ordered:true,steps:[S('Require at least one record.',['exists','at least|one|record'],`I will require that each ${words(m)} has at least one record.`),S('Exclude any non-active record.',['not exists','Active','exclude|non'],`I will use NOT EXISTS to exclude masters with a non-Active record.`)]},
    {skill:'Correlated subquery average',concepts:['correlated subquery','status average'],question:`Find ${words(r)} above the average ${ramount} for their status.`,tables:[r],focus:r,sql:`SELECT ${rid},status,${ramount} FROM ${r} r WHERE ${ramount}>(SELECT AVG(x.${ramount}) FROM ${r} x WHERE x.status=r.status) ORDER BY status,${ramount} DESC;`,ordered:true,steps:[S('Use a correlated status average.',['correlat|status','average|avg',pattern(ramount)],`I will compare each record with the average amount for its own status.`)]},
    {skill:'Date difference between first and last',concepts:['min date','max date','date arithmetic'],question:`Calculate days between the first and last event for each ${words(r)}.`,tables:[r,e],focus:r,sql:`SELECT r.${rid},MIN(e.${edate}) first_event,MAX(e.${edate}) last_event,MAX(e.${edate})-MIN(e.${edate}) active_days FROM ${r} r JOIN ${e} e ON r.${rid}=e.${erid} GROUP BY r.${rid} ORDER BY r.${rid};`,ordered:true,steps:[S('Aggregate first and last dates.',['minimum|min|first','maximum|max|last','group'],`I will group events per record and take minimum and maximum dates.`),S('Subtract the two dates.',['subtract|difference|days'],`I will subtract the first date from the last date to get active days.`)]},
    {skill:'Partition contribution percentage',concepts:['partitioned sum','ratio'],question:`Calculate every event's percentage contribution to its ${words(r)} total.`,tables:[e],focus:e,sql:`SELECT ${eid},${erid},amount,ROUND(100.0*amount/NULLIF(SUM(amount) OVER(PARTITION BY ${erid}),0),2) record_percent FROM ${e} ORDER BY ${erid},${eid};`,ordered:true,steps:[S('Use a partitioned total as denominator.',['percent|contribution','sum','partition'],`I will divide each event amount by the total amount within its record partition.`)]},
    {skill:'Top 1 per segment with ROW_NUMBER()',concepts:['cte','row_number','partition by segment'],question:`Return the highest-value ${words(m)} in each segment.`,tables:[m,r],focus:m,sql:`WITH totals AS (SELECT m.${mid},m.${mname},m.segment,SUM(r.${ramount}) total_amount FROM ${m} m JOIN ${r} r ON m.${mid}=r.${rmid} GROUP BY m.${mid},m.${mname},m.segment), ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY segment ORDER BY total_amount DESC,${mid}) rn FROM totals) SELECT ${mid},${mname},segment,total_amount FROM ranked WHERE rn=1 ORDER BY segment;`,ordered:true,steps:[S('Total record values per master.',['sum|total','group','join|link'],`I will total record amounts for every master and segment.`),S('Rank within segments and keep one.',['row_number|row number','partition','segment','one|1'],`I will row-number masters within each segment and keep rank one.`)]},
    {skill:'Correlated parent average comparison',concepts:['correlated subquery','parent record average'],question:`Find ${words(e)} whose amount is above their parent record average.`,tables:[e],focus:e,sql:`SELECT ${eid},${erid},amount FROM ${e} e WHERE amount>(SELECT AVG(x.amount) FROM ${e} x WHERE x.${erid}=e.${erid}) ORDER BY ${erid},amount DESC;`,ordered:true,steps:[S('Compare with a correlated parent average.',['correlat|parent','average|avg','amount'],`I will compare each event amount with its parent record average.`)]},
    {skill:'Master record count above average',concepts:['cte','left join','subquery average'],question:`Find ${words(m)} whose record count is above the average master record count.`,tables:[m,r],focus:m,sql:`WITH counts AS (SELECT m.${mid},m.${mname},COUNT(r.${rid}) record_count FROM ${m} m LEFT JOIN ${r} r ON m.${mid}=r.${rmid} GROUP BY m.${mid},m.${mname}) SELECT ${mid},${mname},record_count FROM counts WHERE record_count>(SELECT AVG(record_count) FROM counts) ORDER BY record_count DESC,${mid};`,ordered:true,steps:[S('Build record counts including zero.',['left join','count','group'],`I will left join and count records for every master in a CTE.`),S('Compare counts with their average.',['average|avg','above|compare'],`I will keep counts above the average master count.`)]},
    {skill:'Multi-status conditional sums',concepts:['conditional aggregation','three status categories'],question:`Show completed, pending and failed event totals per ${words(r)}.`,tables:[r,e],focus:r,sql:`SELECT r.${rid},SUM(CASE WHEN e.status='Completed' THEN e.amount ELSE 0 END) completed_amount,SUM(CASE WHEN e.status='Pending' THEN e.amount ELSE 0 END) pending_amount,SUM(CASE WHEN e.status='Failed' THEN e.amount ELSE 0 END) failed_amount FROM ${r} r LEFT JOIN ${e} e ON r.${rid}=e.${erid} GROUP BY r.${rid} ORDER BY r.${rid};`,ordered:true,steps:[S('Use three conditional aggregates.',['case','Completed','Pending','Failed','sum|total'],`I will conditionally sum Completed, Pending and Failed event amounts per record.`)]},
    {skill:'Latest row per parent using ROW_NUMBER()',concepts:['cte','row_number','latest event'],question:`Return the latest ${words(e)} row for every ${words(r)}.`,tables:[e],focus:e,sql:`WITH ranked AS (SELECT e.*,ROW_NUMBER() OVER(PARTITION BY ${erid} ORDER BY ${edate} DESC,${eid} DESC) rn FROM ${e} e) SELECT ${eid},${erid},${edate},${etype},amount,status FROM ranked WHERE rn=1 ORDER BY ${erid};`,ordered:true,steps:[S('Rank newest events within each record.',['row_number|row number','partition','descending|desc','date'],`I will row number events per record from newest to oldest.`),S('Keep only the newest row.',['one|1','latest|newest','keep|filter'],`I will keep row number one as the latest event.`)]},
  ];

  return {Beginner:beginner,Intermediate:intermediate,Expert:expert};
}

const scenarios=[],assets={},aliases={};
for(const domain of domains) {
  const built=asset(domain);assets[domain.domain]={schema:built.schema,sample:built.sample};
  const levels=specs(domain);
  for(const level of ['Beginner','Intermediate','Expert']) {
    if(levels[level].length!==20) throw new Error(`${domain.domain} ${level} must contain 20 scenarios`);
    levels[level].forEach((spec,index)=>scenarios.push(makeScenario(domain,level,index+1,spec,built.schemaText)));
  }
}
for(const scenario of scenarios)aliases[scenario.id]=scenario.id;

const output={version:4,requiredDomains:['Banking','Healthcare','Insurance','Capital Markets','Semiconductor','Education'],scenarios,aliases,assets};
fs.writeFileSync(new URL('../data/scenarios.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
console.log(`Wrote ${scenarios.length} scenarios across ${domains.length} domains with metadata and variants.`);
