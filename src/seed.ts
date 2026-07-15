import { db } from './db.js';
import { v4 as uuidv4 } from 'uuid';
import { subDays, subHours } from 'date-fns';

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const NOW = new Date();

const sources = [
  { id: uuidv4(), platform: 'tiktok', sourceType: 'creator', query: '@skincarequeen', language: 'en', videoLimit: 50, refreshSchedule: 'manual', isActive: true, nicheTag: 'skincare' },
  { id: uuidv4(), platform: 'tiktok', sourceType: 'creator', query: '@fitnesshacks', language: 'en', videoLimit: 50, refreshSchedule: 'manual', isActive: true, nicheTag: 'fitness' },
  { id: uuidv4(), platform: 'tiktok', sourceType: 'keyword', query: 'retinol serum', language: 'en', videoLimit: 50, refreshSchedule: 'manual', isActive: true, nicheTag: 'skincare' },
  { id: uuidv4(), platform: 'reels', sourceType: 'creator', query: '@glowup.official', language: 'en', videoLimit: 50, refreshSchedule: 'daily', isActive: true, nicheTag: 'beauty' },
  { id: uuidv4(), platform: 'reels', sourceType: 'hashtag', query: '#peptideskincare', language: 'en', videoLimit: 50, refreshSchedule: 'manual', isActive: true, nicheTag: 'skincare' },
  { id: uuidv4(), platform: 'shorts', sourceType: 'creator', query: '@labcoatbeauty', language: 'en', videoLimit: 50, refreshSchedule: 'weekly', isActive: true, nicheTag: 'skincare' },
];

// Video data: [sourceIdx, creatorHandle, followers, caption, views, likes, comments, shares, saves, durationSec, daysAgo, transcript?]
// Carefully designed to produce realistic outlier scores
const videoData: [number, string, number, string, number, number, number, number?, number?, number, number, string?][] = [
  // ====== @skincarequeen (source 0) — 12K followers, baseline ~15K views ======
  // OUTLIER: 34x
  [0, 'skincarequeen', 12000, 'POV: you mixed retinol with vitamin C for 30 days and your dermatologist is horrified', 512000, 89000, 4200, 23000, 8900, 45, 3,
   "So I saw this TikTok trend saying to mix retinol and vitamin C together and I thought, how bad could it be? Day one, nothing. Day three, my face was on FIRE. By day seven I had chemical burns. I went to my dermatologist and she literally gasped. She said this is the worst case of contact dermatitis she's seen this month. Do NOT mix these two. Ever."],
  // OUTLIER: 18x
  [0, 'skincarequeen', 12000, 'The $4 ingredient that outperformed my $200 serum — here\'s the before and after', 274000, 45000, 2100, 15000, 6700, 38, 5,
   "I spent $200 on this luxury serum and it did absolutely nothing for my hyperpigmentation. Then my esthetician told me to try this $4 ingredient from the drugstore. Azelaic acid. Four weeks later, look at this before and after. My dark spots are literally gone. The $200 serum is going in the trash."],
  // OUTLIER: 8.5x
  [0, 'skincarequeen', 12000, 'I asked 10 dermatologists what they ACTUALLY use on their own skin and the answers shocked me', 128000, 22000, 1800, 8900, 3400, 52, 7,
   "So I went to a dermatology conference and asked 10 dermatologists what products they actually use on their own skin, not what they recommend to patients. Almost all of them said the same three things: sunscreen, moisturizer, and retinoid. That's it. No fancy serums, no 12-step routines."],
  // Normal range
  [0, 'skincarequeen', 12000, 'Morning skincare routine for dry skin ✨', 18000, 3200, 180, 900, 420, 60, 10],
  [0, 'skincarequeen', 12000, 'Reviewing the new CeraVe hydrating cleanser', 14000, 2800, 140, 650, 310, 42, 12],
  [0, 'skincarequeen', 12000, 'Skincare products I regret buying', 11000, 2100, 95, 520, 240, 55, 14],
  [0, 'skincarequeen', 12000, 'How I got rid of my textured skin in 2 weeks', 22000, 4100, 220, 1100, 520, 48, 8],
  // Fresh (<48h)
  [0, 'skincarequeen', 12000, 'Testing the viral snail mucin from Amazon 🐌', 8500, 1200, 60, 300, 150, 35, 0.1],
  [0, 'skincarequeen', 12000, 'GRWM for a dermatologist appointment', 6200, 900, 40, 180, 90, 50, 0.05],

  // ====== @fitnesshacks (source 1) — 45K followers, baseline ~55K views ======
  // OUTLIER: 22x
  [1, 'fitnesshacks', 45000, 'This 2-minute morning stretch replaced my $300/month chiropractor visits', 1210000, 245000, 8900, 45000, 18000, 120, 2,
   "I used to spend $300 a month on chiropractor visits for my lower back pain. Then a physical therapist friend showed me this two-minute morning stretch routine. Cat-cow, child's pose, and this hip flexor opener. Three months later, I haven't been to the chiropractor once. My back pain is completely gone."],
  // OUTLIER: 12x
  [1, 'fitnesshacks', 45000, 'The protein shake mistake that\'s making you GAIN fat (95% of people do this)', 660000, 132000, 5400, 28000, 11000, 30, 4,
   "You're drinking your protein shake wrong and it's literally making you gain fat. If you're blending it with milk, bananas, and peanut butter, that's not a protein shake, that's a 600-calorie meal. Use water or almond milk, keep it under 200 calories, and drink it within 30 minutes of your workout."],
  // Normal range
  [1, 'fitnesshacks', 45000, '5 exercises for bigger arms at home', 62000, 12000, 680, 3200, 1500, 90, 9],
  [1, 'fitnesshacks', 45000, 'What I eat in a day to lose fat', 78000, 15000, 820, 4100, 1900, 60, 11],
  [1, 'fitnesshacks', 45000, 'Full body workout no equipment needed', 48000, 9500, 520, 2500, 1100, 45, 13],
  [1, 'fitnesshacks', 45000, 'How I fixed my posture in 30 days', 55000, 11000, 600, 2800, 1300, 55, 15],

  // ====== keyword: "retinol serum" (source 2) — hashtag source, batch baseline ======
  // Mix of random creators
  [2, 'derm.dr.lee', 850000, 'Why I stopped recommending retinol to my patients', 2340000, 450000, 12000, 89000, 34000, 65, 6],
  [2, 'smoothskin.jess', 3200, 'The retinol serum that cleared my acne scars in ONE WEEK', 89000, 18000, 920, 5600, 2300, 28, 1],
  [2, 'beautybysam', 156000, 'Retinol vs retinoid — what nobody tells you', 320000, 67000, 3400, 18000, 7200, 50, 8],
  [2, 'thatgirl.lily', 5400, 'I put retinol on HALF my face for 60 days and the results are insane', 156000, 34000, 1800, 9800, 4100, 42, 4],
  [2, 'skincareaddict', 2800, 'Best retinol serum under $20 that actually works', 42000, 8900, 450, 2800, 1200, 32, 9],
  [2, 'clearskin.mike', 890, 'Day 1 vs Day 30 retinol journey for acne', 67000, 14000, 720, 4200, 1800, 25, 3],
  [2, 'glow.tips', 12000, 'Retinol purge is a MYTH according to this study', 98000, 21000, 1100, 6200, 2800, 38, 7],

  // ====== @glowup.official (source 3) — 78K followers, baseline ~92K views ======
  // OUTLIER: 15x
  [3, 'glowup.official', 78000, 'I spent $5000 on skin treatments so you don\'t have to — ranking them from WASTE to WORTH IT', 1380000, 289000, 9500, 52000, 21000, 75, 3,
   "I spent five thousand dollars on skin treatments over the past year so you don't have to waste your money. Starting from the biggest waste of money: microcurrent devices. Then LED masks — they're okay but overpriced. Chemical peels at a clinic — game changer. And the number one thing that actually transformed my skin: prescription tretinoin at $15 a tube."],
  // OUTLIER: 6x
  [3, 'glowup.official', 78000, 'The \"glass skin\" routine that made someone ask if I was wearing foundation', 552000, 112000, 4300, 24000, 9800, 58, 5,
   "Someone asked me if I was wearing foundation today and I wasn't. This glass skin routine has completely changed my texture. Double cleansing, toner with niacinamide, snail mucin, and then this hyaluronic acid serum. The key is applying everything on damp skin. Your skin will literally look like glass."],
  // Normal range
  [3, 'glowup.official', 78000, 'Get ready with me for a date night 💅', 85000, 17000, 900, 4800, 2200, 90, 10],
  [3, 'glowup.official', 78000, 'Products that actually work for textured skin', 105000, 21000, 1100, 5600, 2700, 52, 12],
  [3, 'glowup.official', 78000, 'My skincare fridge essentials', 72000, 14000, 750, 3800, 1800, 40, 14],
  // Fresh
  [3, 'glowup.official', 78000, 'New products I\'m testing this month 🧪', 45000, 8200, 380, 2100, 950, 48, 0.02],

  // ====== hashtag: #peptideskincare (source 4) — various creators, batch baseline ======
  [4, 'peptide.guru', 1500, 'Peptides changed my under-eyes in 14 days and I have photos to prove it', 234000, 48000, 2400, 14000, 5600, 35, 2],
  [4, 'science.skin', 420000, 'The science behind copper peptides — more hype than help?', 890000, 178000, 7200, 42000, 18000, 68, 10],
  [4, 'minimalist.maya', 7800, 'I only use 3 products now and my skin has never been better', 45000, 9200, 480, 2800, 1200, 30, 8],
  [4, 'skincare.lab', 34000, 'Peptide serums ranked by concentration (most brands are lying)', 178000, 36000, 1900, 10500, 4300, 55, 5],
  [4, 'natural.glow', 2100, 'The peptide serum from The Ordinary that nobody talks about', 120000, 25000, 1300, 7200, 3100, 28, 1],
  [4, 'derm.sarah', 670000, 'Do peptide serums actually work? A dermatologist reviews 12 brands', 1560000, 320000, 11000, 67000, 28000, 80, 6],

  // ====== @labcoatbeauty (source 5) — 5K followers, baseline ~8K views ======
  // OUTLIER: 40x
  [5, 'labcoatbeauty', 5000, 'I\'m a cosmetic chemist and these are the 5 ingredients I would NEVER put on my skin', 320000, 68000, 3200, 18000, 7500, 62, 2,
   "I'm a cosmetic chemist with 15 years of experience formulating skincare products, and there are five ingredients I would never put on my own skin. Number one: mineral oil. It's basically a barrier that sits on top of your skin and doesn't let anything in or out. Number two: artificial fragrance. It's the number one cause of contact dermatitis."],
  // OUTLIER: 25x
  [5, 'labcoatbeauty', 5000, 'Your expensive serum is expiring and you don\'t even know it — here\'s the secret date code', 200000, 42000, 2100, 12000, 5000, 40, 4,
   "Every skincare product has a secret expiration date that the brands don't want you to know about. Look for this little symbol on the back — it's an open jar icon with a number inside. That number is the months you have after opening it. Most serums expire in 6 months. If you've had that vitamin C serum for a year, it's oxidized and useless."],
  // Normal range
  [5, 'labcoatbeauty', 5000, 'What pH should your cleanser be?', 7200, 1400, 85, 380, 180, 45, 20],
  [5, 'labcoatbeauty', 5000, 'Reading a skincare label like a chemist', 9500, 1800, 110, 520, 240, 55, 18],
  [5, 'labcoatbeauty', 5000, 'Why niacinamide makes some people break out', 11000, 2200, 130, 620, 290, 38, 15],
  // Fresh
  [5, 'labcoatbeauty', 5000, 'Testing a new peptide formulation in the lab 🧪', 3800, 650, 30, 150, 70, 30, 0.03],

  // ====== More videos for variety (additional normal-range videos) ======
  [0, 'skincarequeen', 12000, 'TikTok made me buy these skincare products', 16000, 3000, 160, 800, 380, 50, 16],
  [0, 'skincarequeen', 12000, 'Replying to @user: yes, you CAN use retinol around your eyes', 19500, 3600, 200, 950, 450, 25, 17],
  [1, 'fitnesshacks', 45000, '10-minute ab workout that actually burns', 58000, 11000, 620, 3000, 1400, 600, 16],
  [1, 'fitnesshacks', 45000, 'Why your protein intake is probably wrong', 71000, 14000, 780, 3900, 1700, 48, 18],
  [2, 'randomuser42', 340, 'My retinol results after 90 days', 28000, 5600, 290, 1800, 750, 22, 11],
  [2, 'skincare.jenna', 89000, 'Don\'t buy retinol until you watch this', 420000, 88000, 4600, 25000, 10000, 55, 5],
  [4, 'peptide.fan', 650, 'Budget peptide routine that rivals high-end brands', 15000, 3100, 160, 900, 420, 33, 12],
  [4, 'skincare.nerd', 22000, 'Matrixyl vs Argireline — which peptide is actually better?', 89000, 18000, 950, 5200, 2400, 50, 9],
  [3, 'glowup.official', 78000, 'Skincare red flags at the dermatologist', 98000, 19000, 1050, 5500, 2600, 62, 11],
  [3, 'glowup.official', 78000, 'The one product that fixed my barrier', 115000, 23000, 1200, 6400, 3000, 44, 13],
  [5, 'labcoatbeauty', 5000, 'Debunking the glow recipe hype', 6500, 1200, 70, 340, 160, 50, 22],
  [5, 'labcoatbeauty', 5000, 'What happens when you mix AHAs and BHAs', 8800, 1700, 95, 460, 220, 42, 19],
];

// ---------------------------------------------------------------------------
// Analysis data for top outliers
// ---------------------------------------------------------------------------

const analysisDataMap: Record<string, { analysisJson: string; analysisBasis: string; videoIdx: number }> = {
  // @skincarequeen 34x outlier
  'skincarequeen_retinol_mix': {
    analysisBasis: 'transcript+thumbnail',
    videoIdx: 0,
    analysisBasis: 'video+transcript',
    videoIdx: 0,
    analysisJson: JSON.stringify({
      shots: [
        { timestampSec: 0, durationSec: 2, type: "text_overlay", description: "POV title card: retinol + vitamin C bottles with danger styling", onScreenText: "POV: you mixed retinol with vitamin C for 30 days" },
        { timestampSec: 2, durationSec: 3, type: "talking_head", description: "Creator in bathroom mirror, holding products, excited expression", onScreenText: null },
        { timestampSec: 5, durationSec: 3, type: "talking_head", description: "Day 1-3: quick cuts showing normal skin, creator dismissive", onScreenText: "Day 1... Day 3..." },
        { timestampSec: 8, durationSec: 4, type: "reaction", description: "Day 7: red, inflamed skin close-up, creator horrified", onScreenText: "Day 7" },
        { timestampSec: 12, durationSec: 6, type: "talking_head", description: "Dermatologist office, showing face on screen, doctor's reaction", onScreenText: "my dermatologist GASPED" },
        { timestampSec: 18, durationSec: 5, type: "talking_head", description: "Back to bathroom, serious tone, warning text overlay", onScreenText: "DO NOT mix these 🔴" }
      ],
      onScreenText: [
        { timestampSec: 0, text: "POV: you mixed retinol with vitamin C for 30 days", style: "title_card" },
        { timestampSec: 5, text: "Day 1... Day 3...", style: "overlay" },
        { timestampSec: 8, text: "Day 7", style: "overlay" },
        { timestampSec: 12, text: "my dermatologist GASPED", style: "overlay" },
        { timestampSec: 18, text: "DO NOT mix these 🔴", style: "overlay" }
      ],
      audioAnalysis: {
        speechDetected: true,
        speechType: "direct_address",
        musicDescription: "Low-volume trending suspense sound underneath speech",
        soundEffects: ["whoosh on day transitions", "dramatic sting on Day 7 reveal"],
        tone: "Shifts from casual/excited to alarmed, then to serious warning"
      },
      emotionalArc: [
        { timestampSec: 0, primaryEmotion: "curiosity", intensity: 8, trigger: "POV hook — viewer relates to the mistake" },
        { timestampSec: 5, primaryEmotion: "anticipation", intensity: 6, trigger: "Day-by-day countdown starts" },
        { timestampSec: 8, primaryEmotion: "shock", intensity: 9, trigger: "Red inflamed skin revealed" },
        { timestampSec: 12, primaryEmotion: "anxiety", intensity: 8, trigger: "Dermatologist's shocked reaction" },
        { timestampSec: 18, primaryEmotion: "relief", intensity: 7, trigger: "Clear actionable warning" }
      ],
      hook: {
        text: "POV: you mixed retinol with vitamin C for 30 days and your dermatologist is horrified",
        type: "POV",
        placement: "on_screen",
        mechanism: "The POV hook drops the viewer directly into a relatable mistake, creating immediate identification and anxiety about having made the same error. The 'dermatologist is horrified' creates a curiosity gap — what went wrong?"
      },
      angle: {
        type: "myth_busting",
        description: "Busts the TikTok trend of mixing incompatible active ingredients by showing the real consequences through personal experience"
      },
      storytellingBeats: [
        { type: "hook", timestampSec: 0, description: "POV title card with retinol + vitamin C imagery" },
        { type: "setup", timestampSec: 2, description: "Sees the TikTok trend, decides to try it" },
        { type: "escalation", timestampSec: 5, description: "Days 1-3 progression, face starts burning" },
        { type: "conflict", timestampSec: 8, description: "Day 7: chemical burns, visits dermatologist" },
        { type: "reveal", timestampSec: 12, description: "Dermatologist's reaction and diagnosis" },
        { type: "cta", timestampSec: 18, description: "Warning: do NOT mix these two, ever" }
      ],
      keyMechanisms: [
        "POV identification — viewer recognizes themselves in the mistake",
        "escalation tension — builds from curiosity to horror over 30 days",
        "authority validation — dermatologist confirms the danger",
        "temporal structure — day-by-day creates suspense",
        "cautionary tale format — warning embedded in entertainment"
      ],
      emotionalDrivers: ["anxiety", "curiosity", "relief", "validation"],
      pacing: {
        rhythm: "Starts conversational, accelerates through the day-by-day escalation, slows for the dermatologist reveal, quick warning at the end",
        retentionStrategy: "Each day reveal creates a 'what happened next' pull. The dermatologist gasp at day 7 is the retention anchor.",
        cutsPerMinute: 12
      },
      visualTechniques: [
        "Face progression shots showing skin reaction",
        "Dermatologist reaction shot",
        "Split-screen before/after comparison",
        "Day-counter text overlays"
      ],
      audioTechniques: [
        "Trending sound underneath speech",
        "Dramatic pause before dermatologist reveal",
        "Sound effect stingers on day transitions"
      ],
      audienceInsight: {
        targetDemographic: "Women 20-40 interested in skincare who follow trends but lack deep ingredient knowledge",
        unspokenDesire: "Wanting clear skin quickly without doing the research, combined with fear of damaging their skin"
      },
      transferablePatterns: [
        {
          pattern: "The Dangerous Trend Deconstruction",
          description: "Take a viral trend that seems harmless, follow it yourself, document the real consequences day by day, then get expert validation.",
          adaptationNotes: "Works in any niche where there are harmful myths. The key is personal experience + expert backup."
        },
        {
          pattern: "The 30-Day Cautionary Timeline",
          description: "Structure content as a day-by-day progression where the stakes escalate, culminating in a dramatic reveal.",
          adaptationNotes: "The timeline format creates natural suspense. Can be adapted to any experiment or challenge format."
        }
      ],
      overallAssessment: {
        summary: "This video went viral because it combined a relatable skincare mistake with escalating tension and expert validation. The POV format creates immediate identification, while the day-by-day structure keeps viewers watching to see how bad it gets.",
        viralityScore: 8,
        replicability: "high"
      }
    })
  },
  // @fitnesshacks 22x outlier
  'fitnesshacks_chiro': {
    analysisBasis: 'video+transcript',
    videoIdx: 9,
    analysisJson: JSON.stringify({
      shots: [
        { timestampSec: 0, durationSec: 3, type: "talking_head", description: "Creator in bedroom, direct to camera, shocked expression", onScreenText: "$300/month → $0" },
        { timestampSec: 3, durationSec: 12, type: "talking_head", description: "Creator showing old chiropractor receipts, frustrated body language", onScreenText: null },
        { timestampSec: 15, durationSec: 10, type: "talking_head", description: "Creator explaining PT friend's advice, hopeful tone", onScreenText: "3 stretches" },
        { timestampSec: 25, durationSec: 30, type: "demonstration", description: "Floor mat, demonstrates cat-cow, child's pose, hip flexor stretch with form cues", onScreenText: "1. Cat-Cow  2. Child's Pose  3. Hip Flexor" },
        { timestampSec: 55, durationSec: 5, type: "talking_head", description: "Back to camera, smiling, no pain, holding up zero fingers", onScreenText: "3 months pain-free" }
      ],
      onScreenText: [
        { timestampSec: 0, text: "$300/month → $0", style: "overlay" },
        { timestampSec: 25, text: "1. Cat-Cow  2. Child's Pose  3. Hip Flexor", style: "overlay" },
        { timestampSec: 55, text: "3 months pain-free", style: "overlay" }
      ],
      audioAnalysis: {
        speechDetected: true,
        speechType: "direct_address",
        musicDescription: "Calm lo-fi beat, low volume during demonstration",
        soundEffects: ["subtle whoosh on stretch transitions"],
        tone: "Shifts from frustrated to hopeful to satisfied"
      },
      emotionalArc: [
        { timestampSec: 0, primaryEmotion: "curiosity", intensity: 9, trigger: "$300/month figure creates instant value interest" },
        { timestampSec: 3, primaryEmotion: "frustration", intensity: 7, trigger: "Showing old chiropractor bills" },
        { timestampSec: 15, primaryEmotion: "hope", intensity: 8, trigger: "PT friend's simple recommendation" },
        { timestampSec: 25, primaryEmotion: "empowerment", intensity: 7, trigger: "Easy stretches anyone can do" },
        { timestampSec: 55, primaryEmotion: "relief", intensity: 9, trigger: "3 months pain-free result" }
      ],
      hook: {
        text: "This 2-minute morning stretch replaced my $300/month chiropractor visits",
        type: "bold_claim",
        placement: "spoken",
        mechanism: "The specific dollar amount ($300/month) anchors the value claim, making it concrete rather than vague. The 'replaced' creates a before/after curiosity gap — what could possibly replace expensive professional treatment?"
      },
      angle: {
        type: "insider_secret",
        description: "Frames a simple stretch routine as insider knowledge that could save thousands, positioning the creator as someone with privileged information"
      },
      storytellingBeats: [
        { type: "hook", timestampSec: 0, description: "Bold money-saving claim with dollar figure" },
        { type: "setup", timestampSec: 3, description: "Backstory: chronic back pain, expensive chiropractor" },
        { type: "reveal", timestampSec: 15, description: "Physical therapist friend's recommendation" },
        { type: "proof", timestampSec: 25, description: "Demonstrates the 3 stretches with form cues" },
        { type: "cta", timestampSec: 55, description: "Results after 3 months — pain gone, no more visits" }
      ],
      keyMechanisms: [
        "dollar anchor — specific cost creates concrete value perception",
        "authority proxy — 'physical therapist friend' adds credibility without being an expert",
        "demonstration value — shows the actual routine, not just talking about it",
        "ROI framing — $300/month saved is a powerful motivator",
        "simplicity signal — '2 minutes' removes the effort barrier"
      ],
      emotionalDrivers: ["hope", "frustration_with_costs", "relief", "empowerment"],
      pacing: {
        rhythm: "Quick hook, brief emotional setup, then shifts to instructional demonstration, ending with results",
        retentionStrategy: "The dollar figure hooks, the personal story creates empathy, and the demonstration delivers the promised value.",
        cutsPerMinute: 8
      },
      visualTechniques: [
        "Demonstration cuts showing each stretch from multiple angles",
        "Text overlays with stretch names",
        "Results text overlay at the end"
      ],
      audioTechniques: [
        "Calm background music during demonstration",
        "Emphasis on key stretches with slight volume bump"
      ],
      audienceInsight: {
        targetDemographic: "Adults 25-50 with sedentary jobs experiencing back pain, frustrated with recurring medical costs",
        unspokenDesire: "A simple, free solution to chronic pain that doesn't require ongoing professional treatment"
      },
      transferablePatterns: [
        {
          pattern: "The Cost Replacement Claim",
          description: "Lead with a specific dollar amount you no longer spend because of a simple alternative. The concrete number creates instant value perception.",
          adaptationNotes: "Works for any product/service that replaces something expensive. The key is the specific dollar figure, not a vague 'saves money' claim."
        }
      ],
      overallAssessment: {
        summary: "Went viral by combining a specific monetary claim with a practical demonstration. The $300/month figure creates immediate interest, and the 2-minute routine delivers on the promise. The 'physical therapist friend' authority proxy adds credibility.",
        viralityScore: 9,
        replicability: "high"
      }
    })
  },
  // @glowup.official 15x outlier — thumbnail+caption only
  'glup_ranking': {
    analysisBasis: 'thumbnail+caption',
    // This one is text-only — observation fields are null
    videoIdx: 13,
    analysisJson: JSON.stringify({
      shots: null,
      onScreenText: null,
      audioAnalysis: null,
      emotionalArc: null,
      hook: {
        text: "I spent $5000 on skin treatments so you don't have to",
        type: "bold_claim",
        placement: "on_screen",
        mechanism: "The $5000 specific amount creates shock value and curiosity. The 'so you don't have to' frames the creator as a generous tester who took the financial risk for the audience."
      },
      angle: {
        type: "social_proof",
        description: "Personal experience testing multiple expensive treatments, creating authority through having actually tried them all"
      },
      storytellingBeats: [
        { type: "hook", timestampSec: 0, description: "WASTE to WORTH IT ranking intro" },
        { type: "setup", timestampSec: 3, description: "Shows the $5000 total spent" },
        { type: "escalation", timestampSec: 8, description: "Ranks from worst to best with reactions" },
        { type: "reveal", timestampSec: 40, description: "Number 1 reveal: $15 tretinoin tube" },
        { type: "cta", timestampSec: 55, description: "Final verdict and savings tip" }
      ],
      keyMechanisms: [
        "ranking format — naturally creates binge-worthy countdown structure",
        "extreme spending anchor — $5000 makes any savings feel significant",
        "contrarian ending — cheapest option wins creates surprise",
        "before/after evidence — visual proof for each treatment"
      ],
      emotionalDrivers: ["curiosity", "shock", "relief", "vindication"],
      pacing: {
        rhythm: "Fast-paced ranking countdown with reaction cuts between each treatment",
        retentionStrategy: "The ranking format creates natural 'what's next' momentum. The surprise ending (cheapest wins) is the retention payoff.",
        cutsPerMinute: null
      },
      visualTechniques: [
        "Product placement and reaction shots",
        "Before/after comparison slides",
        "Ranking number overlays (5 to 1)"
      ],
      audioTechniques: [
        "Trending audio underneath speech",
        "Sound effects on ranking transitions"
      ],
      audienceInsight: {
        targetDemographic: "Women 22-38 interested in skincare, frustrated by expensive products with unclear results",
        unspokenDesire: "Wanting someone else to test expensive treatments and tell them which ones actually work"
      },
      transferablePatterns: [
        {
          pattern: "The Expensive Truth Ranking",
          description: "Test multiple expensive options in a category and rank them, with the twist that the cheapest option often wins. Creates shock value and shareability.",
          adaptationNotes: "Works in any category with a range of price points. The key is genuinely testing everything and being honest about surprises."
        }
      ],
      overallAssessment: {
        summary: "Likely went viral through the ranking format combined with the shock of spending $5000 and the surprise ending that the cheapest option won. Visual evidence for each treatment adds credibility.",
        viralityScore: 7,
        replicability: "medium"
      },
      confidenceNotes: "Analysis based on thumbnail, caption, and metadata only. Visual technique descriptions are inferred from the caption structure. Audio and specific visual details may differ."
    })
  },
};

export async function seedDatabase() {
  console.log('🌱 Seeding Slashloop database...');

  // Clear all tables (respect FK order)
  console.log('  Clearing existing data...');
  await db.swipeEntry.deleteMany();
  await db.hook.deleteMany();
  await db.analysis.deleteMany();
  await db.score.deleteMany();
  await db.brief.deleteMany();
  await db.idea.deleteMany();
  await db.refreshRun.deleteMany();
  await db.video.deleteMany();
  await db.baseline.deleteMany();
  await db.board.deleteMany();
  await db.usageLog.deleteMany();
  await db.source.deleteMany();
  await db.workspace.deleteMany();
  try { await db.$executeRawUnsafe('DELETE FROM sqlite_sequence'); } catch { /* sqlite_sequence may not exist */ }

  // 1. Create workspace
  console.log('  Creating workspace...');
  const workspace = await db.workspace.create({
    data: {
      id: uuidv4(),
      name: 'Default',
      monthlyBudgetCents: 5000,
      autoAnalyzeRulesJson: JSON.stringify({
        minOutlierScore: 5.0,
        minViews: 10000,
        minEngagementRate: 3,
        dailyLimit: 10,
      }),
    },
  });
  console.log(`  ✓ Workspace: ${workspace.name} (${workspace.id})`);

  // 2. Create sources
  console.log('  Creating sources...');
  for (const s of sources) {
    await db.source.create({
      data: { ...s, workspaceId: workspace.id },
    });
  }
  console.log(`  ✓ ${sources.length} sources created`);

  // 3. Create videos
  console.log('  Creating videos...');
  let videoCount = 0;
  const sourceMap = new Map<string, string>();
  for (let i = 0; i < sources.length; i++) {
    sourceMap.set(String(i), sources[i].id);
  }

  const createdVideos: any[] = [];

  for (const [srcIdx, handle, followers, caption, views, likes, comments, shares, saves, duration, daysAgo, transcript] of videoData) {
    const sourceId = sourceMap.get(String(srcIdx))!;
    const postedAt = subHours(NOW, daysAgo * 24);
    const externalId = `ext_${handle}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const video = await db.video.create({
      data: {
        id: uuidv4(),
        sourceId,
        platform: sources[srcIdx].platform,
        externalId,
        url: sources[srcIdx].platform === 'tiktok'
          ? `https://www.tiktok.com/@${handle}/video/${externalId}`
          : sources[srcIdx].platform === 'reels'
            ? `https://www.instagram.com/reel/${externalId}/`
            : `https://www.youtube.com/shorts/${externalId}`,
        thumbnailUrl: `https://placehold.co/400x700/1a1a2e/e94560?text=${encodeURIComponent(handle)}+${videoCount + 1}`,
        creatorHandle: handle,
        creatorFollowers: followers,
        caption,
        postedAt,
        views,
        likes,
        comments,
        shares: shares ?? null,
        saves: saves ?? null,
        durationSec: duration,
        transcript: transcript || null,
        transcriptSource: transcript ? 'captions' : 'none',
        rawJson: JSON.stringify({ mock: true, source: 'seed' }),
      },
    });

    createdVideos.push(video);
    videoCount++;
  }
  console.log(`  ✓ ${videoCount} videos created`);

  // 4. Compute baselines and scores
  console.log('  Computing baselines and scores...');

  // Group videos by creator+platform to compute baselines
  const creatorVideos = new Map<string, any[]>();
  for (const v of createdVideos) {
    const key = `${v.creatorHandle}__${v.platform}`;
    if (!creatorVideos.has(key)) creatorVideos.set(key, []);
    creatorVideos.get(key)!.push(v);
  }

  let scoreCount = 0;
  for (const [key, videos] of creatorVideos) {
    const [handle, platform] = key.split('__');

    // Compute trimmed median baseline
    const nonFreshVideos = videos.filter(v => {
      const hours = (NOW.getTime() - new Date(v.postedAt).getTime()) / (1000 * 60 * 60);
      return hours >= 48;
    });

    const viewsArr = nonFreshVideos.map(v => v.views).sort((a, b) => a - b);
    const dropCount = Math.max(1, Math.floor(viewsArr.length * 0.1));
    const trimmed = viewsArr.slice(dropCount, viewsArr.length - dropCount);
    const mid = Math.floor(trimmed.length / 2);
    const medianViews = trimmed.length > 0
      ? Math.max(500, trimmed.length % 2 !== 0 ? trimmed[mid] : (trimmed[mid - 1] + trimmed[mid]) / 2)
      : 500;

    // Store baseline
    await db.baseline.create({
      data: { creatorHandle: handle, platform, medianViews, sampleSize: viewsArr.length },
    });

    // Score each video
    for (const v of videos) {
      const hours = (NOW.getTime() - new Date(v.postedAt).getTime()) / (1000 * 60 * 60);

      if (hours < 48) {
        await db.score.create({
          data: {
            videoId: v.id,
            outlierScore: 0,
            scoreType: 'too_fresh',
            explanation: '⏳ Too fresh — posted less than 48 hours ago. Score will be calculated on next refresh.',
          },
        });
        scoreCount++;
        continue;
      }

      const outlierScore = Math.round((v.views / medianViews) * 10) / 10;
      const scoreType = nonFreshVideos.length >= 5 ? 'actual' : 'estimated';

      const formatN = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);

      let explanation: string;
      if (scoreType === 'actual') {
        explanation = outlierScore >= 5
          ? `🚀 OUTLIER — ${formatN(v.views)} views vs. this creator's typical ~${formatN(medianViews)} — ${outlierScore}x their normal performance`
          : outlierScore >= 2
            ? `📈 Above average — ${formatN(v.views)} views vs. this creator's typical ~${formatN(medianViews)} — ${outlierScore}x their normal performance`
            : `📊 Normal range — ${formatN(v.views)} views vs. this creator's typical ~${formatN(medianViews)} — ${outlierScore}x their normal performance`;
      } else {
        explanation = `📊 Estimated — ${formatN(v.views)} views vs. batch median ~${formatN(medianViews)} — ${outlierScore}x (limited creator history)`;
      }

      await db.score.create({
        data: { videoId: v.id, outlierScore, scoreType, explanation },
      });
      scoreCount++;
    }
  }
  console.log(`  ✓ ${scoreCount} scores computed`);

  // 5. Create analyses for top outliers
  console.log('  Creating analyses...');
  const videoByIndex = createdVideos;
  let analysisCount = 0;

  for (const [key, data] of Object.entries(analysisDataMap)) {
    const video = videoByIndex[data.videoIdx];
    if (!video) continue;

    const analysis = await db.analysis.create({
      data: {
        id: uuidv4(),
        videoId: video.id,
        schemaVersion: 'v2',
        analysisJson: data.analysisJson,
        analysisBasis: data.analysisBasis,
        backend: data.analysisBasis === 'thumbnail+caption' ? 'gemini-text' : 'gemini-native',
        model: 'gemini-2.5-flash-lite',
        costCents: data.analysisBasis === 'thumbnail+caption' ? 0.1 : 0.2,
      },
    });
    analysisCount++;

    // Create hooks only for video analyses (not caption-only)
    if (data.analysisBasis.startsWith('video')) {
      const parsed = JSON.parse(data.analysisJson);
      const hook = parsed.hook;
      if (hook && hook.text) {
        await db.hook.create({
          data: {
            id: uuidv4(),
            analysisId: analysis.id,
            videoId: video.id,
            text: hook.text,
            hookType: hook.type,
            placement: 'spoken',
            origin: 'extracted',
            nicheTag: video.caption.includes('skincare') || video.caption.includes('skin') ? 'skincare' : 'fitness',
          },
        });
      }
    }
  }
  console.log(`  ✓ ${analysisCount} analyses + hooks created`);

  // 6. Create boards
  console.log('  Creating boards...');
  const board1 = await db.board.create({
    data: { id: uuidv4(), workspaceId: workspace.id, name: 'UGC hooks' },
  });
  const board2 = await db.board.create({
    data: { id: uuidv4(), workspaceId: workspace.id, name: 'Competitor angles' },
  });

  // Add swipe entries to first board (top 3 outlier videos)
  const topOutliers = createdVideos.filter(v => {
    // we'll just pick the first few analyzed videos
    return true;
  }).slice(0, 3);

  for (const v of topOutliers) {
    const analysis = await db.analysis.findFirst({ where: { videoId: v.id } });
    await db.swipeEntry.create({
      data: {
        id: uuidv4(),
        boardId: board1.id,
        videoId: v.id,
        analysisSnapshotJson: analysis ? analysis.analysisJson : '{}',
        notes: 'High-performing outlier — potential hook source',
      },
    });
  }

  // Add to second board
  const competitorVideos = createdVideos.slice(3, 6);
  for (const v of competitorVideos) {
    await db.swipeEntry.create({
      data: {
        id: uuidv4(),
        boardId: board2.id,
        videoId: v.id,
        analysisSnapshotJson: '{}',
        notes: 'Competitor content pattern worth tracking',
      },
    });
  }
  console.log(`  ✓ 2 boards with ${topOutliers.length + competitorVideos.length} entries`);

  // 7. Create ideas
  console.log('  Creating ideas...');
  const firstAnalysis = await db.analysis.findFirst({ where: { analysisBasis: { startsWith: 'video' } } });
  if (firstAnalysis) {
    await db.idea.create({
      data: {
        id: uuidv4(),
        videoId: firstAnalysis.videoId,
        analysisId: firstAnalysis.id,
        transferablePattern: 'The Dangerous Trend Deconstruction — test a viral trend yourself, document consequences day by day, get expert validation',
        whyItWorked: 'Combines relatable mistake (mixing ingredients) with escalating tension and expert authority. The day-by-day format creates natural suspense.',
        adaptation: 'For our skincare brand: test a viral DIY skincare recipe, document skin reactions over 14 days, have our dermatologist partner comment on the results.',
        status: 'new',
      },
    });

    const secondAnalysis = await db.analysis.findFirst({ where: { analysisBasis: { startsWith: 'video' } }, skip: 1 });
    if (secondAnalysis) {
      await db.idea.create({
        data: {
          id: uuidv4(),
          videoId: secondAnalysis.videoId,
          analysisId: secondAnalysis.id,
          transferablePattern: 'The Cost Replacement Claim — lead with a specific dollar amount saved by a simple alternative',
          whyItWorked: 'The $300/month figure creates instant value perception. The 2-minute routine delivers on the promise with zero friction.',
          adaptation: 'For our brand: "This $8 product replaced my $80 dermatologist treatment" — show our product as the affordable alternative with a simple routine.',
          status: 'briefed',
        },
      });
    }
  }
  console.log('  ✓ 2 ideas created');

  // 8. Create a brief
  console.log('  Creating brief...');
  const briefedIdea = await db.idea.findFirst({ where: { status: 'briefed' } });
  const briefAnalysis = briefedIdea?.analysisId
    ? await db.analysis.findUnique({ where: { id: briefedIdea.analysisId! } })
    : null;

  if (briefAnalysis) {
    await db.brief.create({
      data: {
        id: uuidv4(),
        ideaId: briefedIdea!.id,
        analysisId: briefAnalysis.id,
        briefJson: JSON.stringify({
          concept: "A UGC creator shares how our $8 hero product replaced their expensive professional treatment, demonstrating the routine in under 60 seconds with before/after proof.",
          hook: "This $8 product replaced my $80/month dermatologist treatment — here's the exact routine",
          creatorDirection: "Natural, casual delivery like talking to a friend. Film in bathroom with good lighting. Show genuine surprise at the results. No hard sell — let the results speak.",
          talkingPoints: [
            "I was spending $80/month on professional treatments",
            "A dermatologist friend told me to try this instead",
            "Here's the exact 2-minute routine I follow every morning",
            "Look at my skin after 30 days — the results speak for themselves"
          ],
          visualBeats: [
            { timestampSec: 0, description: "Hook text overlay with dollar figure, creator looking shocked" },
            { timestampSec: 3, description: "Show the expensive product being put away" },
            { timestampSec: 8, description: "Reveal our product, show the price tag" },
            { timestampSec: 15, description: "Demonstrate the routine step by step" },
            { timestampSec: 35, description: "Before/after split screen" },
            { timestampSec: 50, description: "Final verdict with product in hand" }
          ],
          whatNotToCopy: [
            "Don't mention competitor brand names",
            "Don't make medical claims about curing conditions",
            "Don't use professional medical equipment in the video"
          ],
          deliverableSpecs: {
            length: "45-60 seconds",
            format: "vertical 9:16",
            platform: "tiktok"
          }
        }),
      },
    });
    console.log('  ✓ 1 brief created');
  }

  // 9. Create usage logs
  console.log('  Creating usage logs...');
  await db.usageLog.createMany({
    data: [
      { id: uuidv4(), workspaceId: workspace.id, kind: 'scrape', provider: 'tiktok', units: 45, costCents: 9, createdAt: subDays(NOW, 1) },
      { id: uuidv4(), workspaceId: workspace.id, kind: 'scrape', provider: 'instagram', units: 32, costCents: 6, createdAt: subDays(NOW, 1) },
      { id: uuidv4(), workspaceId: workspace.id, kind: 'ai', provider: 'google', units: 3, costCents: 0.6, createdAt: subDays(NOW, 0.5) },
      { id: uuidv4(), workspaceId: workspace.id, kind: 'scrape', provider: 'youtube', units: 28, costCents: 0, createdAt: subDays(NOW, 2) },
      { id: uuidv4(), workspaceId: workspace.id, kind: 'ai', provider: 'google', units: 1, costCents: 0.2, createdAt: subDays(NOW, 0.2) },
    ],
  });
  console.log('  ✓ 5 usage log entries');

  // 10. Create refresh run logs
  console.log('  Creating refresh runs...');
  for (let i = 0; i < sources.length; i++) {
    await db.refreshRun.create({
      data: {
        id: uuidv4(),
        sourceId: sources[i].id,
        itemsPulled: 15 + Math.floor(Math.random() * 20),
        newVideos: 3 + Math.floor(Math.random() * 8),
        errorsJson: '[]',
        costCents: i < 3 ? 5 + Math.floor(Math.random() * 8) : 0,
        ranAt: subHours(NOW, (i + 1) * 4),
      },
    });
    // Update source lastRefreshedAt
    await db.source.update({
      where: { id: sources[i].id },
      data: { lastRefreshedAt: subHours(NOW, (i + 1) * 4) },
    });
  }
  console.log(`  ✓ ${sources.length} refresh runs`);

  console.log('\n✅ Seed complete!');
  console.log(`  Workspace: ${workspace.name}`);
  console.log(`  Sources: ${sources.length}`);
  console.log(`  Videos: ${videoCount}`);
  console.log(`  Scores: ${scoreCount}`);
  console.log(`  Analyses: ${analysisCount}`);
  console.log(`  Boards: 2`);
  console.log(`  Ideas: 2`);
  console.log(`  Briefs: 1`);
}

// Run if executed directly
if (import.meta.path === Bun.main) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}