// Shared scoring logic — loaded before each site-specific content script

var KUROMOJI_DICT_URL = chrome.runtime.getURL('dict');
var DICT_FILES = [
  'base.dat.gz', 'check.dat.gz', 'cc.dat.gz',
  'tid.dat.gz', 'tid_map.dat.gz', 'tid_pos.dat.gz',
  'unk.dat.gz', 'unk_char.dat.gz', 'unk_compat.dat.gz', 'unk_invoke.dat.gz', 'unk_map.dat.gz', 'unk_pos.dat.gz',
];
var MM_CONTENT_POS = new Set(['名詞','動詞','形容詞','形容動詞','副詞','連体詞','感動詞']);
// Superset of MM_CONTENT_POS used only for deciding which tokens get a hoverable
// .jp-tok span (so discourse connectors like そして/しかし can carry a grammar
// tag). Deliberately NOT used by the score%/known-word-count functions below —
// adding 接続詞 there would shift every video's score, which is out of scope for
// "detect more grammar points."
var MM_TAGGABLE_POS = new Set([...MM_CONTENT_POS, '接続詞']);
var NUMERAL_RE = /^[0-9０-９]+$/;

// ── Conjugation/particle-form hints (labels shown in the hover tooltip when
// the "Enable conjugation form hints" setting is on) ─────────────────────
// 動詞,接尾 voice suffix (れる/られる/せる/させる/できる etc.) → English label.
var CONJ_VOICE_MAP = {
  'れる': 'Passive', 'られる': 'Passive', 'せる': 'Causative', 'させる': 'Causative',
  'できる': 'Potential', '出来る': 'Potential', 'なさる': 'Honorific', '致す': 'Humble', 'いたす': 'Humble',
  'がる': 'Shows outward signs of (~garu)',
};
// 助動詞 (auxiliary) basic_form → English label. だ has a special case at its
// merge site below (prev.pos disambiguates verb-euphonic past 読んだ from the
// plain copula 学生だ) — the 'だ':'Past' entry here is just its fallback default.
var CONJ_AUX_MAP = {
  'た': 'Past', 'だ': 'Past', 'ない': 'Negative', 'ぬ': 'Negative', 'ん': 'Negative',
  'ます': 'Polite', 'たい': 'Desire (~tai)', 'よう': 'Volitional', 'う': 'Volitional',
  'まい': 'Negative volitional', 'べきだ': 'Should', 'べし': 'Should',
  'らしい': 'Seems', 'そうだ': 'Hearsay/Looks like', 'ようだ': 'Seems like', 'みたいだ': 'Seems like',
  'なら': 'Conditional (~nara)', 'ござる': 'Very polite "to be" (~gozaru)',
  // ある here means it showed up as 助動詞 (dependent aux), which only happens
  // in the である construction — the standalone verb ある ("to exist/have")
  // has pos 動詞 and never reaches this map, so no collision.
  'ある': 'Formal copula (~de aru)', 'じゃん': 'Casual assertion "isn\'t it" (~jan)',
  'つ': 'Classical past/perfect (~tsu, archaic)',
  'なり': 'Classical copula (~nari, archaic/formal)',
  'じ': 'Classical negative volitional (~ji, archaic)',
};
// て-form continuation helper 動詞 basic_form → English label (more specific than plain "Te-form").
var CONJ_TE_HELPER_MAP = {
  'いる': 'Continuous (~te iru)', 'ある': 'Resultant state (~te aru)', 'しまう': 'Completion (~te shimau)',
  'おく': 'Preparatory (~te oku)', 'くる': 'Ingressive (~te kuru)', 'いく': 'Inchoative (~te iku)', 'みる': 'Trial (~te miru)',
  'くださる': 'Please do (~te kudasai)', 'くれる': 'Doing me a favor (~te kureru)',
  'あげる': 'Doing a favor for someone (~te ageru)', 'もらう': 'Receiving a favor (~te morau)',
  'もらえる': 'Receiving a favor, potential (~te moraeru)', 'やる': 'Doing a favor for someone, casual (~te yaru)',
  'いただく': 'Receiving a favor, humble (~te itadaku)',
  'ほしい': 'Wanting someone to do (~te hoshii)',
  'みせる': 'Showing/demonstrating (~te miseru)',
  'ごらん': 'Trial, honorific (~te goran)',
  '見る': 'Trial (~te miru)',
};
// Casual contraction of て + しまう/しまった — fused into one 動詞 token (基本形
// ちゃう/じゃう) with no separate て to trigger the te-helper merge above, so it
// needs its own direct-merge branch in Step 2 (see below).
var CONJ_CHAU_MAP = { 'ちゃう': 'Completion (~chau, casual ~te shimau)', 'じゃう': 'Completion (~jau, casual ~te shimau)' };
// Case/binding particle surface → grammatical role, for the noun "form" hint.
// Restricted to 格助詞/係助詞/連体化 (の's own category) so sentence-final particles
// (ね/よ/か…) aren't mislabeled.
var CONJ_PARTICLE_MAP = {
  'は': 'Topic', 'が': 'Subject', 'を': 'Object', 'に': 'Location/Time/Target',
  'で': 'Location/Means', 'へ': 'Direction', 'と': 'With/And', 'から': 'From',
  'まで': 'Until', 'の': 'Possessive/Modifier', 'も': 'Also/Too', 'より': 'Than/From',
  // Fixed 連語 (compound expression) entries IPADIC still files under 格助詞.
  'について': 'Regarding (~ni tsuite)', 'として': 'As/In the role of (~to shite)',
  'にとって': 'For/From the perspective of (~ni totte)',
  'によって': 'By means of/According to (~ni yotte)',
  'に対して': 'Towards/In contrast to (~ni taishite)',
  'にかけて': 'Ranging from/to (~ni kakete)',
  'に関して': 'Regarding (~ni kanshite)', 'に関する': 'Regarding, attributive (~ni kansuru)',
  'に対する': 'Towards/In contrast to, attributive (~ni taisuru)',
  'による': 'By means of/According to, attributive (~ni yoru)',
};
var CONJ_PARTICLE_DETAILS = ['格助詞', '係助詞', '連体化'];
// Casual quotative/topic って (and its っていう contraction of という) — unlike
// the case particles above it isn't noun-only (来るって言った attaches to a
// verb), so it gets its own broad-attachment branch rather than living in
// CONJ_PARTICLE_MAP.
var CONJ_TTE_LABEL = 'Casual quotative/topic (~tte)';
// 接続助詞 (conjunctive particle linking two clauses) surface → English label.
// て/で are excluded — those already get dedicated te-form merge handling above
// and are gone (folded into the verb) by the time this runs.
var CONJ_CONJUNCTIVE_MAP = {
  'ながら': 'Simultaneous (~nagara, "while doing")',
  'けど': 'Contrast (~kedo, "but", casual)', 'けれど': 'Contrast (~keredo, "but")',
  'けれども': 'Contrast (~keredomo, "but", formal)',
  'が': 'Contrast (~ga, "but")', 'し': 'Reason listing (~shi, "and, also")',
  'ので': 'Reason (~node, "because", soft)', 'のに': 'Contrary to expectation (~noni, "even though")',
  'ば': 'Conditional (~ba, "if")', 'から': 'Reason (~kara, "because")',
  'と': 'Conditional (~to, "when/if")',
  // Casual contraction of ~ては (te + wa) — distinct from ちゃう/じゃう
  // (completion) above, this ちゃ is the conditional/topic "if you ~" pattern
  // (書いちゃだめ "mustn't write").
  'ちゃ': 'Casual conditional/topic (~cha, contraction of ~te wa)',
  'けども': 'Contrast (~kedomo, "but", formal)',
  // なり here means "as soon as ~" (接続助詞 usage) — distinct from the
  // なり…なり "either...or" listing usage below (副助詞/並立助詞).
  'なり': 'As soon as (~nari)',
  'んで': 'Casual reason (~nde, contracted ~node)',
  'ても': 'Even if (~temo)',
  'たって': 'Even if (~tatte, casual ~temo)',
  'て': 'Conjunctive te-form (~te)', 'で': 'Conjunctive te-form (~de)',
  'じゃ': 'Casual conjunctive (~ja, contracted ~dewa)',
};
// 並立助詞 (coordinating/listing particle) surface → English label.
var CONJ_PARALLEL_MAP = {
  'たり': 'Listing representative actions (~tari)', 'だり': 'Listing representative actions (~dari)',
  'や': 'Informal listing (~ya, "and, among others")',
  'とか': 'Casual listing/example (~toka, "like, such as")',
  'と': 'Listing "and" (~to)',
  // なり…なり "either X or Y" listing use — distinct from the 接続助詞 "as soon
  // as ~" なり in CONJ_CONJUNCTIVE_MAP.
  'なり': 'Either/or listing (~nari...nari)',
};
// 副助詞 (adverbial/restrictive particle) surface → English label. Attaches to
// the nearest preceding content word (can follow a verb or noun, e.g. 話しただけ
// "just talked" vs 話しかしない "doesn't do anything but talk").
var CONJ_ADVERBIAL_MAP = {
  'だけ': 'Only/Just (~dake)', 'しか': 'Nothing but (~shika, needs negative)',
  'ばかり': 'Only/Just did (~bakari)', 'のみ': 'Only (~nomi, formal)',
  'さえ': 'Even (~sae)', 'こそ': 'Emphatic "precisely" (~koso)',
  'など': 'Et cetera (~nado)', 'かも': 'Possibility (~kamo, "maybe")',
  // Mid-sentence か is a different usage than sentence-final か (Question, in
  // CONJ_SENTENCE_MAP below) — here it makes an interrogative pronoun indefinite
  // (誰か "someone", 何か "something") or lists alternatives (りんごかバナナ "apple or banana").
  'か': 'Indefinite/alternative (~ka, "some-"/"or")',
  // でも here is the fused 副助詞 "even" (子供でも "even a child") — distinct
  // from standalone sentence-initial でも, which is the 接続詞 in
  // CONJ_DISCOURSE_MAP below ("but/however").
  'でも': 'Even (~demo)',
  'なんか': 'Casual example/hedge (~nanka, "something like")',
  'なんて': 'Such a thing as (~nante, surprise/disdain)',
  'ずつ': 'Distributive (~zutsu, "each/apiece")',
  'くらい': 'Approximation (~kurai, "about/around")', 'ぐらい': 'Approximation (~gurai, "about/around")',
  // じゃ is the casual contraction of では — most often seen right before ない
  // (じゃない/じゃなく/じゃなくて), but IPADIC sometimes fuses the whole thing
  // into one token depending on context, so all variants are listed.
  'じゃ': 'Casual copula "de wa" (~ja, often before ない)',
  'じゃない': 'Casual negative copula (~ja nai)', 'じゃなく': 'Casual negative copula (~ja naku)',
  'じゃなくて': 'Casual negative copula (~ja nakute)',
  // まで also shows up tagged 副助詞 (not just its usual 格助詞) in some
  // contexts, same "until/up to" meaning either way.
  'まで': 'Until', 'だって': 'Casual hearsay/reason (~datte)',
  'ほど': 'Extent/comparison (~hodo, "to the extent of")',
  'ばっかり': 'Only/Just did (~bakkari, casual ~bakari)',
  // Fused forms that show up when だ/です's own conjugated pieces get absorbed
  // into a preceding particle's surface during merge (じゃ+あり+ませ+ん,
  // だけ+で, etc.) — same underlying meaning as their unfused counterparts.
  'じゃなかった': 'Casual negative copula past (~ja nakatta)',
  'じゃありません': 'Casual polite negative copula (~ja arimasen)',
  'だけで': 'Only/Just (~dake)', 'だけな': 'Only/Just (~dake)',
  // は sometimes absorbs a following ない (via the generic 助動詞 fold, which
  // doesn't know it's attaching onto は specifically) before Step 3 gets a
  // chance to tag は itself — はなく covers that fused case with は's own label.
  'はなく': 'Topic',
  // なり…なり "either X or Y" — the first occurrence in the pair is often
  // tagged 副助詞 while the second is 並立助詞 (see CONJ_PARALLEL_MAP), same
  // construction either way.
  'なり': 'Either/or listing (~nari...nari)',
};
// 接続詞 (conjunction) or a specific discourse-connector 副詞 → English label.
// Self-tags the connector word itself (it's promoted into MM_TAGGABLE_POS below).
var CONJ_DISCOURSE_MAP = {
  'そして': 'Sequential connector (~soshite, "and then")',
  'しかし': 'Contrastive connector (~shikashi, "however")',
  'でも': 'Contrastive connector (~demo, "but/however")',
  'だから': 'Causal connector (~dakara, "so/therefore")',
  'それで': 'Causal connector (~sorede, "and so")',
  'ところで': 'Topic-change connector (~tokorode, "by the way")',
  'たとえば': 'Example marker (~tatoeba, "for example")',
  'なぜなら': 'Causal connector (~naze nara, "because/the reason is")',
  'つまり': 'Summary connector (~tsumari, "in other words")',
  'ただし': 'Qualifier connector (~tadashi, "however, provided that")',
  'なお': 'Additional-note connector (~nao, "additionally, note that")',
  'すると': 'Sequential connector (~suruto, "and then, thereupon")',
  'または': 'Alternative connector (~mataha, "or")',
  'もしくは': 'Alternative connector (~moshikuwa, "or", formal)',
  'また': 'Additive/repetition connector (~mata, "also"/"again")',
  // たって sometimes tags 副詞 (basic_form たって itself, "even if ~") — a
  // different tokenization from 立って (verb 立つ + て, "standing, and..."),
  // so no collision risk with the ordinary verb.
  'たって': 'Even if (~tatte)',
};
// Sentence-final particle (終助詞) surface → its function. Attaches to the nearest
// preceding content word (verb/adjective/noun), not just nouns, since it marks the
// whole utterance — e.g. 聞いてみませんか "won't you try listening?" tags the verb with "Question".
var CONJ_SENTENCE_MAP = {
  'か': 'Question', 'のか': 'Question', 'かな': 'Wondering (~kana)', 'かしら': 'Wondering (~kashira)',
  'ね': 'Seeking agreement (~ne)', 'よ': 'Assertion/emphasis (~yo)',
  'な': 'Emphasis/prohibition (~na)', 'わ': 'Softening emphasis (~wa)',
  'ぞ': 'Strong assertion (~zo)', 'ぜ': 'Strong assertion (~ze)',
  'さ': 'Casual assertion (~sa)', 'の': 'Casual question (~no)',
  // Casual contraction of の (explanatory nominalizer) — when it lands as its
  // own 終助詞 token rather than the 名詞 nominalizer の already handled via
  // です/だ attachment elsewhere.
  'ん': 'Casual explanatory (~n, contraction of の)', 'なぁ': 'Seeking agreement (~naa, elongated ~na)',
  'っけ': 'Reminiscing question (~kke, "was it...?")',
};
// Fast category checks used by the sidebar to sort tags into Conjugation /
// Particle roles / Connectors buckets.
var CONJ_PARTICLE_LABELS = new Set([
  ...Object.values(CONJ_PARTICLE_MAP), ...Object.values(CONJ_SENTENCE_MAP), ...Object.values(CONJ_ADVERBIAL_MAP),
  ...Object.values(CONJ_CONJUNCTIVE_MAP), ...Object.values(CONJ_PARALLEL_MAP), CONJ_TTE_LABEL,
]);
var CONJ_DISCOURSE_LABELS = new Set(Object.values(CONJ_DISCOURSE_MAP));
// Tag label → representative kana/kanji, for linking out to MaruMori's grammar
// dictionary (marumori.io/grammar?q=…). Built by inverting the surface→label
// maps above (first surface wins when a label has more than one, e.g. Passive
// has both れる and られる) — kept in sync automatically as those maps grow.
var CONJ_LABEL_TO_SURFACE = {};
for (const m of [CONJ_VOICE_MAP, CONJ_AUX_MAP, CONJ_TE_HELPER_MAP, CONJ_CHAU_MAP, CONJ_PARTICLE_MAP, CONJ_SENTENCE_MAP,
  CONJ_ADVERBIAL_MAP, CONJ_CONJUNCTIVE_MAP, CONJ_PARALLEL_MAP, CONJ_DISCOURSE_MAP]) {
  for (const [surface, label] of Object.entries(m)) {
    if (!(label in CONJ_LABEL_TO_SURFACE)) CONJ_LABEL_TO_SURFACE[label] = surface;
  }
}
Object.assign(CONJ_LABEL_TO_SURFACE, {
  'Polite copula (~desu)': 'です', 'Copula (~da)': 'だ', 'Past copula (~datta)': 'だった',
  'Quotative (~to, "that ~")': 'と', 'Te-form': 'て',
  'Easy to do (~yasui)': 'やすい', 'Hard to do (~nikui)': 'にくい',
  'Hard to do (~gatai, formal/emotional)': 'がたい', 'Uncomfortable/hard to do (~zurai)': 'づらい',
  [CONJ_TTE_LABEL]: 'って', 'Copula te-form (~de, "is X, and...")': 'で',
});
// Tag label → hover explanation shown as a native title tooltip on the tag chip.
var CONJ_TAG_INFO = {
  'Passive':              'Passive voice — the subject receives the action (e.g. 言われる "is said").',
  'Causative':            'Causative — subject makes or lets someone do something (e.g. 言わせる "make (someone) say").',
  'Potential':            'Potential — expresses ability, "can do" (e.g. 話せる "can speak").',
  'Honorific':            'Honorific speech — respectful form used for someone else\'s action.',
  'Humble':               'Humble speech — modest form used for one\'s own action.',
  'Past':                 'Past tense — the action already happened.',
  'Negative':             'Negative — the action does not/did not happen.',
  'Polite':               'Polite ます form.',
  'Desire (~tai)':        '～たい — expresses "want to do".',
  'Volitional':           'Volitional — "let\'s"/"shall", expresses intention.',
  'Negative volitional':  '～まい — "probably not"/"won\'t".',
  'Should':               '～べき — "should"/"ought to".',
  'Seems':                '～らしい — hearsay or appearance, "seems like".',
  'Hearsay/Looks like':   '～そうだ — hearsay, or visual "looks like".',
  'Seems like':           '～ようだ/みたいだ — conjecture, "seems like".',
  'Te-form':              'て/で form — connects clauses or links to a following verb.',
  'Continuous (~te iru)': '～ている — an ongoing action or the resulting state.',
  'Resultant state (~te aru)': '～てある — a deliberate, prepared resulting state.',
  'Completion (~te shimau)':   '～てしまう — the action is completed (often with regret/surprise).',
  'Preparatory (~te oku)':     '～ておく — done in advance, as preparation.',
  'Ingressive (~te kuru)':     '～てくる — a change approaching or coming into being.',
  'Inchoative (~te iku)':      '～ていく — a change moving away or developing onward.',
  'Trial (~te miru)':          '～てみる — trying something out.',
  'Topic':                 'は — marks the sentence topic ("as for...").',
  'Subject':               'が — marks the grammatical subject.',
  'Object':                'を — marks the direct object.',
  'Location/Time/Target':  'に — marks a location, point in time, or target of the action.',
  'Location/Means':        'で — marks the location of an action, or the means/method used.',
  'Direction':             'へ — marks the direction of movement.',
  'With/And':              'と — "with" (companion) or "and" (listing).',
  'From':                  'から — marks a starting point or origin.',
  'Until':                 'まで — marks an ending point or limit.',
  'Possessive/Modifier':   'の — shows possession or links a noun to modify another.',
  'Also/Too':              'も — "also"/"too".',
  'Than/From':             'より — comparison ("than") or a starting point.',
  'Question':                'か — turns the sentence into a question.',
  'Wondering (~kana)':        'かな — casual "I wonder".',
  'Wondering (~kashira)':     'かしら — casual "I wonder" (feminine).',
  'Seeking agreement (~ne)':  'ね — seeks agreement or confirmation, "right?".',
  'Assertion/emphasis (~yo)': 'よ — asserts new information the listener may not know, adds emphasis.',
  'Emphasis/prohibition (~na)': 'な — casual emphasis, or after a plain-form verb a prohibition ("don\'t ~").',
  'Softening emphasis (~wa)':   'わ — softens the statement while adding emphasis (often feminine/Kansai speech).',
  'Strong assertion (~zo)':     'ぞ — blunt, forceful assertion (masculine).',
  'Strong assertion (~ze)':     'ぜ — blunt, casual assertion (masculine).',
  'Casual assertion (~sa)':     'さ — casual, matter-of-fact assertion.',
  'Casual question (~no)':     'の — casual spoken question, said with rising intonation.',
  'Copula (~da)':               'だ — plain "is/are" (non-past), the casual counterpart of です.',
  'Past copula (~datta)':       'だった — plain past "was/were", the casual counterpart of でした.',
  'Polite copula (~desu)':      'です — polite "is/are", attaches after a noun or na-adjective predicate.',
  'Quotative (~to, "that ~")':  'と — marks a quote or thought before 言う/思う/考える/etc., "says/thinks that ~".',
  'Only/Just (~dake)':          'だけ — restricts to exactly this, "only/just".',
  'Nothing but (~shika, needs negative)': 'しか — "nothing but ~", always paired with a negative verb.',
  'Only/Just did (~bakari)':    'ばかり — "just did X" (recently) or "nothing but X".',
  'Only (~nomi, formal)':       'のみ — formal/written "only".',
  'Even (~sae)':                'さえ — "even ~", extreme example.',
  'Emphatic "precisely" (~koso)': 'こそ — emphasizes "precisely this one", "this is exactly the ~".',
  'Et cetera (~nado)':          'など — "et cetera", softens a list or example as non-exhaustive.',
  'Possibility (~kamo, "maybe")': 'かも — short for かもしれない, "might/perhaps".',
  'Sequential connector (~soshite, "and then")': 'そして — connects two clauses/sentences in sequence, "and then".',
  'Contrastive connector (~shikashi, "however")': 'しかし — formal "however/but", contrasts with what came before.',
  'Contrastive connector (~demo, "but/however")': 'でも — casual "but/however".',
  'Causal connector (~dakara, "so/therefore")':   'だから — "so/therefore", states a consequence.',
  'Causal connector (~sorede, "and so")':          'それで — "and so/because of that".',
  'Topic-change connector (~tokorode, "by the way")': 'ところで — shifts to a new, often unrelated topic.',
  'Example marker (~tatoeba, "for example")':      'たとえば — introduces an example.',
  'Causal connector (~naze nara, "because/the reason is")': 'なぜなら — introduces the reason for what was just said, often paired with ～からだ.',
  'Conditional (~nara)':   'なら — "if/in the case that ~", a conditional.',
  'Shows outward signs of (~garu)': '～がる — describes someone showing outward signs of a feeling (e.g. 欲しがる "acts like they want").',
  'Simultaneous (~nagara, "while doing")': '～ながら — doing two things at the same time.',
  'Contrast (~kedo, "but", casual)':    'けど — casual "but/though".',
  'Contrast (~keredo, "but")':          'けれど — "but/though".',
  'Contrast (~keredomo, "but", formal)': 'けれども — formal/polite "but/though".',
  'Contrast (~ga, "but")':              'が — "but", connects two contrasting clauses (distinct from subject-marking が).',
  'Reason listing (~shi, "and, also")': 'し — lists reasons/facts, "and, what\'s more".',
  'Reason (~node, "because", soft)':    'ので — softer, more objective "because" than から.',
  'Contrary to expectation (~noni, "even though")': 'のに — "even though/despite", often with a note of surprise or complaint.',
  'Conditional (~ba, "if")':            'ば — hypothetical conditional, "if ~".',
  'Listing representative actions (~tari)': '～たり～たりする — lists a few representative actions among others.',
  'Informal listing (~ya, "and, among others")': 'や — informal "and" for a partial list of items.',
  'Casual listing/example (~toka, "like, such as")': 'とか — casual "like/such as", also used for informal listing.',
  'Summary connector (~tsumari, "in other words")': 'つまり — "in other words", summarizes or clarifies.',
  'Qualifier connector (~tadashi, "however, provided that")': 'ただし — adds a condition or exception to what was just said.',
  'Additional-note connector (~nao, "additionally, note that")': 'なお — adds a supplementary note.',
  'Sequential connector (~suruto, "and then, thereupon")': 'すると — "and then/thereupon", often introduces a surprising result.',
  'Alternative connector (~mataha, "or")': 'または — "or", presents an alternative.',
  'Alternative connector (~moshikuwa, "or", formal)': 'もしくは — formal/written "or".',
  'Additive/repetition connector (~mata, "also"/"again")': 'また — "also" (additive) or "again" (repetition), depending on context.',
  'Easy to do (~yasui)':   '～やすい — "easy to do".',
  'Hard to do (~nikui)':   '～にくい — "hard/awkward to do".',
  'Hard to do (~gatai, formal/emotional)': '～がたい — "hard to do", often emotionally ("hard to accept/forgive").',
  'Uncomfortable/hard to do (~zurai)':     '～づらい — "uncomfortable/painful to do".',
  'Regarding (~ni tsuite)': 'について — "regarding/about ~".',
  'Indefinite/alternative (~ka, "some-"/"or")': 'か (mid-sentence) — makes an interrogative pronoun indefinite (誰か "someone") or lists an alternative ("A か B", "A or B").',
  'Very polite "to be" (~gozaru)': 'ござる — very polite/formal "to be", as in ありがとうございます.',
  'Please do (~te kudasai)': '～てください — polite request, "please do ~".',
  'Doing me a favor (~te kureru)': '～てくれる — someone does this for me/us, a favor.',
  'Completion (~chau, casual ~te shimau)': '～ちゃう — casual contraction of ～てしまう, "end up doing/finish doing".',
  'Completion (~jau, casual ~te shimau)': '～じゃう — casual contraction of ～でしまう (voiced verb stem), same meaning as ～ちゃう.',
  'As/In the role of (~to shite)': 'として — "as/in the capacity of ~".',
  [CONJ_TTE_LABEL]: 'って — casual contraction of と言う/という/とは, marks a quote, topic, or naming ("Tanaka-san, do you know [him]?", "he said [that] he\'s coming").',
  'Reason (~kara, "because")': 'から (after a verb/adjective/predicate) — "because ~", states a reason (distinct from the case-particle から "from").',
  'Conditional (~to, "when/if")': 'と (after a verb/adjective) — "when/if ~ happens, then ~", a natural-consequence conditional.',
  'Listing "and" (~to)': 'と (between nouns) — exhaustive "and", lists every item (赤と青 "red and blue").',
  'Even (~demo)': 'でも (fused with a noun) — "even ~", an extreme example (子供でも "even a child").',
  'Casual example/hedge (~nanka, "something like")': 'なんか — casual "something like, kind of", softens a suggestion or example.',
  'Such a thing as (~nante, surprise/disdain)': 'なんて — "such a thing as ~", often with surprise or disdain.',
  'Distributive (~zutsu, "each/apiece")': 'ずつ — "each/apiece", distributes a quantity evenly.',
  'Approximation (~kurai, "about/around")': 'くらい — "about/around", an approximate amount.',
  'Approximation (~gurai, "about/around")': 'ぐらい — "about/around", same as くらい (voiced variant).',
  'Casual copula "de wa" (~ja, often before ない)': 'じゃ — casual contraction of では, most often seen right before ない.',
  'Casual negative copula (~ja nai)': 'じゃない — casual "is not", contraction of では ない.',
  'Casual negative copula (~ja naku)': 'じゃなく — casual "is not, and ~", the connective form of じゃない.',
  'Casual negative copula (~ja nakute)': 'じゃなくて — casual "is not, and ~", te-form of じゃない.',
  'Casual explanatory (~n, contraction of の)': 'ん — casual spoken contraction of the explanatory の (as in ～んです).',
  'Seeking agreement (~naa, elongated ~na)': 'なぁ — elongated/emphatic な, softly seeking agreement or expressing feeling ("〜だなぁ").',
  'Copula te-form (~de, "is X, and...")': 'で (copula) — te-form of だ/です, links "is X, and..." to the next clause.',
  'Formal copula (~de aru)': 'である — formal/written "to be", used in essays and formal writing.',
  'Casual assertion "isn\'t it" (~jan)': 'じゃん — casual "isn\'t it/right?", asserting something obvious.',
  'Doing a favor for someone (~te ageru)': '～てあげる — doing an action as a favor for someone else.',
  'Receiving a favor (~te morau)': '～てもらう — having someone do an action for you/as a favor.',
  'Casual hearsay/reason (~datte)': 'だって — casual "(they say) that ~" (hearsay) or "but/because" (excuse-giving).',
  'Extent/comparison (~hodo, "to the extent of")': 'ほど — "to the extent of/as ~ as", a comparison.',
  'Only/Just did (~bakkari, casual ~bakari)': 'ばっかり — casual pronunciation of ばかり.',
  'Casual conditional/topic (~cha, contraction of ~te wa)': 'ちゃ — casual contraction of ～ては, "if you ~" (書いちゃだめ "mustn\'t write").',
  'Listing representative actions (~dari)': '～だり～だりする — voiced variant of ～たり, same meaning.',
  'Reminiscing question (~kke, "was it...?")': 'っけ — casually asks about something half-remembered, "was it...?".',
  'For/From the perspective of (~ni totte)': 'にとって — "for/from the perspective of ~".',
  'By means of/According to (~ni yotte)': 'によって — "by means of/according to/depending on ~".',
  'Towards/In contrast to (~ni taishite)': 'に対して — "towards/in contrast to ~".',
  'Ranging from/to (~ni kakete)': 'にかけて — "ranging from ~ to ~", spans a range.',
  'Receiving a favor, potential (~te moraeru)': '～てもらえる — potential form of ～てもらう, "can have someone do this for me".',
  'Doing a favor for someone, casual (~te yaru)': '～てやる — casual/rougher version of ～てあげる.',
  'Casual negative copula past (~ja nakatta)': 'じゃなかった — casual "was not".',
  'Casual polite negative copula (~ja arimasen)': 'じゃありません — polite-but-casual "is not".',
  'Contrast (~kedomo, "but", formal)': 'けども — slightly more formal variant of けど, "but/though".',
  'As soon as (~nari)': 'なり — "as soon as ~", one action immediately triggers the next.',
  'Either/or listing (~nari...nari)': 'なり…なり — "either X or Y", lists options non-exhaustively.',
  'Regarding (~ni kanshite)': 'に関して — formal "regarding/concerning ~".',
  'Regarding, attributive (~ni kansuru)': 'に関する — attributive form of に関して, modifies a following noun ("~に関する本" "a book about ~").',
  'Towards/In contrast to, attributive (~ni taisuru)': 'に対する — attributive form of に対して, modifies a following noun.',
  'By means of/According to, attributive (~ni yoru)': 'による — attributive form によって, modifies a following noun ("~による被害" "damage caused by ~").',
  'Even if (~tatte)': 'たって — casual "even if ~".',
};

// Observe document.body once it's guaranteed to exist. document_idle normally means
// body is already there, but on non-HTML documents (e.g. Chrome's built-in XML/JSON
// viewer) no <body> is ever created, so a bare `.observe(document.body, …)` throws
// "parameter 1 is not of type 'Node'". Defer to DOMContentLoaded in that case.
function mcObserveBody(callback, opts) {
  const start = () => { if (document.body) new MutationObserver(callback).observe(document.body, opts); };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}

var _tokenizer = null;
var _tokenizerPromise = null;

function getTokenizer() {
  if (_tokenizer) return Promise.resolve(_tokenizer);
  if (_tokenizerPromise) return _tokenizerPromise;
  _tokenizerPromise = (async () => {
    // Pre-fetch all dict files with fetch() then serve from cache via XHR stub.
    window._kuromojiDictCache = {};
    for (const f of DICT_FILES) {
      try {
        const r = await fetch(`${KUROMOJI_DICT_URL}/${f}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        window._kuromojiDictCache[f] = await r.arrayBuffer();
      } catch (e) {
        _tokenizerPromise = null;
        throw e;
      }
    }

    return new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: KUROMOJI_DICT_URL }).build((err, t) => {
        if (err) { _tokenizerPromise = null; reject(err); }
        else     { _tokenizer = t; resolve(t); }
      });
    });
  })();
  return _tokenizerPromise;
}

function hasKanji(s) { return /[一-龯㐀-䶿]/.test(s); }

// Full token-merging pipeline:
//   1) compound noun merging (vocab-aware greedy)
//   2) honorific prefix (接頭詞 お/ご) prepended to next word
//   3) copula (です) left alone — never merged or scored
//   4) て/で particle after 動詞 → pendingTe; following 動詞 (helper verb) → merged in
//   5) 助動詞 (ます/た/ない/etc.) → merged into previous content token
function buildMergedTokens(rawTokens, vocabSet) {
  // Step 1: compound noun merging
  const step1 = [];
  let i = 0;
  while (i < rawTokens.length) {
    const tok = rawTokens[i];
    if (tok.pos === '名詞' && !NUMERAL_RE.test(tok.surface_form)) {
      let surface = tok.surface_form;
      let bestLen = 0;
      const maxJ = Math.min(rawTokens.length, i + 4);
      for (let j = i + 1; j < maxJ; j++) {
        if (rawTokens[j].pos !== '名詞' || NUMERAL_RE.test(rawTokens[j].surface_form)) break;
        surface += rawTokens[j].surface_form;
        if (vocabSet.has(surface)) bestLen = j - i + 1;
      }
      if (bestLen > 1) {
        let combined = '', combinedReading = '';
        for (let k = i; k < i + bestLen; k++) {
          combined += rawTokens[k].surface_form;
          combinedReading += rawTokens[k].reading || rawTokens[k].surface_form;
        }
        step1.push({ surface_form: combined, basic_form: combined, reading: combinedReading, pos: '名詞', pos_detail_1: tok.pos_detail_1 });
        i += bestLen;
        continue;
      }
    }
    step1.push(rawTokens[i]);
    i++;
  }

  // Step 2: prefix / te-form / auxiliary merging
  const out = [];
  let pendingPrefix = null;

  for (const tok of step1) {
    if (tok.pos === '接頭詞' && !pendingPrefix) {
      pendingPrefix = { surface_form: tok.surface_form, reading: tok.reading || tok.surface_form };
      continue;
    }

    let surface = tok.surface_form;
    let basic   = (tok.basic_form && tok.basic_form !== '*') ? tok.basic_form : surface;
    let reading = tok.reading || surface;

    if (pendingPrefix) {
      surface = pendingPrefix.surface_form + surface;
      basic   = pendingPrefix.surface_form + basic;
      reading = pendingPrefix.reading + reading;
      pendingPrefix = null;
    }

    const isCopula = basic === 'です';
    const prev = out.length ? out[out.length - 1] : null;

    // Hiragana-only 動詞 directly after 名詞 = verb inflection attachment
    // e.g. 壊(名詞) + れ(動詞) → 壊れ promoted to 動詞 so て-form merging can follow
    if (!isCopula && tok.pos === '動詞' && /^[ぁ-ん]+$/.test(surface) && prev?.pos === '名詞' && prev._merge) {
      prev.surface_form += surface;
      prev.basic_form    = (prev.basic_form || prev.surface_form) + basic;
      prev.reading       = (prev.reading    || '') + reading;
      prev.pos = '動詞';
      continue;
    }

    // Passive/causative/potential suffix (れる/られる/せる/させる — IPADIC
    // tags these 動詞,接尾, not 助動詞) directly after 動詞 → merge into stem.
    // Keep prev.basic_form as the plain dictionary form (e.g. 言う) so
    // known-check still matches the root verb, same as the 助動詞 fold below.
    if (!isCopula && tok.pos === '動詞' && tok.pos_detail_1 === '接尾' && prev?._merge && prev.pos === '動詞') {
      prev.surface_form += surface;
      prev.reading = (prev.reading || '') + reading;
      const voiceLbl = CONJ_VOICE_MAP[basic];
      if (voiceLbl) prev.conj.push(voiceLbl);
      continue;
    }

    // て/で after 動詞 or 形容詞 (i-adjective te-form, e.g. 高くて) → merge and mark as pendingTe
    if (!isCopula && tok.pos === '助詞' && (surface === 'て' || surface === 'で') && prev?._merge && (prev.pos === '動詞' || prev.pos === '形容詞')) {
      prev.surface_form += surface;
      prev._pendingTe = true;
      prev.conj.push('Te-form');
      continue;
    }

    // Helper 動詞 continuing a te-form (ている/てある/てしまう/etc.)
    if (!isCopula && tok.pos === '動詞' && prev?._pendingTe) {
      prev.surface_form += surface;
      prev._pendingTe = false;
      const helperLbl = CONJ_TE_HELPER_MAP[basic];
      if (helperLbl) prev.conj[prev.conj.length - 1] = helperLbl; // replace generic "Te-form" with the specific meaning
      continue;
    }

    // ちゃう/じゃう — casual contraction of てしまう. IPADIC tokenizes it as a
    // single 動詞 (基本形 ちゃう/じゃう) directly after the verb stem, with no
    // separate て to trigger _pendingTe above, so it needs its own direct merge.
    if (!isCopula && tok.pos === '動詞' && (basic === 'ちゃう' || basic === 'じゃう') && prev?._merge && prev.pos === '動詞') {
      prev.surface_form += surface;
      prev.conj.push(CONJ_CHAU_MAP[basic]);
      continue;
    }

    // 助動詞 (ます、た、ない、etc.) → fold into previous content word.
    // だ is ambiguous on its own: after a 動詞 it's the euphonic past ending
    // (読んだ → "Past", same as た), but after a 名詞/形容動詞 it's the plain
    // copula "is"/"was" — disambiguate using prev.pos, which basic_form can't do.
    if (!isCopula && tok.pos === '助動詞' && prev?._merge) {
      prev.surface_form += surface;
      let auxLbl;
      if (basic === 'だ' && prev.pos !== '動詞') {
        if (surface === 'だった') auxLbl = 'Past copula (~datta)';
        else if (surface === 'で') auxLbl = 'Copula te-form (~de, "is X, and...")';
        else auxLbl = 'Copula (~da)';
      } else {
        auxLbl = CONJ_AUX_MAP[basic];
      }
      if (auxLbl) prev.conj.push(auxLbl);
      continue;
    }

    out.push({
      surface_form: surface,
      basic_form:   basic,
      reading,
      pos:          tok.pos,
      pos_detail_1: tok.pos_detail_1 || '',
      _merge:       !isCopula,
      _pendingTe:   false,
      conj:         [],
      // Separate from conj: labels for a *particle* that informationally tags a
      // preceding content word (も/か/だけ/です…). Kept apart so sidebar/tooltip
      // counting (which reads conj) doesn't double-count the same grammar point
      // once on the content word and again on the particle.
      markConj:     [],
      // Reference to the content-word token this particle attaches to (set
      // alongside markConj below) — lets the hover card opened from the
      // particle's marker span show that word's full info, not the particle's.
      markTarget:   null,
    });
  }

  // Step 3: particle/connector "form" hints (particles are never merged into a
  // preceding word above, so these look at the following/nearby token instead).
  // Each label goes on the content word's conj (drives its hover-card Grammar
  // tab / sidebar count) AND on the particle/marker token's markConj — the
  // latter is what lets the subtitle-overlay highlight land on the actual
  // particle (も/か/だけ/です…) instead of underlining the whole word it
  // modifies, without double-counting the same grammar point in either list.
  const prevContentIdx = k => {
    for (let j = k - 1; j >= 0; j--) if (MM_CONTENT_POS.has(out[j].pos)) return j;
    return -1;
  };
  // IPADIC sometimes can't disambiguate a particle's role from the dictionary
  // alone and returns every candidate category joined with "／" (real example:
  // か always comes back as "副助詞／並立助詞／終助詞", never a single clean
  // value) — check membership in that set rather than exact string equality.
  const posDetailHas = (tok, cat) => (tok.pos_detail_1 || '').split('／').includes(cat);
  // Nouns か can follow to make an interrogative pronoun/noun indefinite (誰か)
  // or list an alternative (りんごか) — as opposed to marking a question (the
  // ～のか/～ですか/～ますか pattern), where it follows a verb/adjective/aux or
  // the empty nominalizer の, never a genuinely referential noun.
  const REFERENTIAL_NOUN_DETAILS = new Set(['一般', '固有名詞', '代名詞', '数']);

  for (let k = 0; k < out.length; k++) {
    const cur = out[k];

    // です — isCopula, so it never merges above and arrives here as its own
    // standalone entry (unlike だ, which does merge — see its special case in
    // Step 2). Tag the preceding content word it's the predicate of.
    if (cur.basic_form === 'です') {
      const idx = prevContentIdx(k);
      if (idx >= 0) { out[idx].conj.push('Polite copula (~desu)'); cur.markTarget = out[idx]; }
      cur.markConj.push('Polite copula (~desu)');
      continue;
    }

    // と + いう/思う/考える/信じる/感じる → quotative "that ~", tag the verb
    // itself. IPADIC tags this と as plain 格助詞 (pos_detail_2 "引用"/quotation,
    // which buildMergedTokens doesn't currently track) — so it's matched here
    // by the specific verb that follows rather than by particle sub-category.
    if (cur.pos === '動詞' && ['いう', '言う', '思う', '考える', '信じる', '感じる'].includes(cur.basic_form)
      && out[k - 1]?.pos === '助詞' && out[k - 1]?.surface_form === 'と') {
      cur.conj.push('Quotative (~to, "that ~")');
      continue;
    }

    // 接続詞, or a specific discourse-connector 副詞 (たとえば) → self-tag.
    if (cur.pos === '接続詞' || cur.pos === '副詞') {
      const lbl = CONJ_DISCOURSE_MAP[cur.basic_form] || CONJ_DISCOURSE_MAP[cur.surface_form];
      if (lbl) cur.conj.push(lbl);
      continue;
    }

    // 動詞 + やすい/にくい/がたい/づらい → "easy/hard to do", tag the adjective
    // itself (it's already its own 形容詞 token/span, so no attachment needed).
    if (cur.pos === '形容詞' && ['やすい', 'にくい', 'がたい', 'づらい'].includes(cur.basic_form) && out[k - 1]?.pos === '動詞') {
      cur.conj.push({
        'やすい': 'Easy to do (~yasui)', 'にくい': 'Hard to do (~nikui)',
        'がたい': 'Hard to do (~gatai, formal/emotional)', 'づらい': 'Uncomfortable/hard to do (~zurai)',
      }[cur.basic_form]);
      continue;
    }

    if (cur.pos !== '助詞') continue;

    // Casual quotative/topic って (っていう = casual という) — unlike case
    // particles this isn't noun-only (来るって言った attaches to a verb), so it
    // gets its own broad nearest-content-word attachment.
    if (cur.surface_form === 'って' || cur.surface_form === 'っていう') {
      const idx = prevContentIdx(k);
      if (idx >= 0) { out[idx].conj.push(CONJ_TTE_LABEL); cur.markTarget = out[idx]; }
      cur.markConj.push(CONJ_TTE_LABEL);
      continue;
    }

    // という sometimes arrives as one fused 格助詞 token (IPADIC dictionary
    // entry) instead of separate と+いう tokens — same quotative/naming
    // meaning as the と+いう branch above, so reuse its label.
    if (cur.surface_form === 'という') {
      const lbl = 'Quotative (~to, "that ~")';
      const idx = prevContentIdx(k);
      if (idx >= 0) { out[idx].conj.push(lbl); cur.markTarget = out[idx]; }
      cur.markConj.push(lbl);
      continue;
    }

    // か is maximally ambiguous in IPADIC (see posDetailHas comment above) —
    // disambiguate by what comes before it instead of trusting pos_detail_1:
    // preceded by a referential noun (誰/りんご/pronoun/proper noun/number) →
    // indefinite-marker or alternative-listing use; anything else (verb,
    // adjective, auxiliary, or the empty nominalizer の) → sentence-final
    // question use.
    if (cur.surface_form === 'か' && (posDetailHas(cur, '終助詞') || posDetailHas(cur, '副助詞') || posDetailHas(cur, '並立助詞'))) {
      const prevTok = out[k - 1];
      const isReferentialNoun = prevTok?.pos === '名詞' && REFERENTIAL_NOUN_DETAILS.has(prevTok.pos_detail_1);
      const lbl = isReferentialNoun ? CONJ_ADVERBIAL_MAP['か'] : CONJ_SENTENCE_MAP['か'];
      const idx = prevContentIdx(k);
      if (idx >= 0) { out[idx].conj.push(lbl); cur.markTarget = out[idx]; }
      cur.markConj.push(lbl);
      continue;
    }

    // Sentence-final particle (ね/よ/な…) → attaches to the nearest preceding
    // content word, since it marks the whole utterance rather than one noun.
    // These can stack (よね), so each one independently finds its own target.
    if (posDetailHas(cur, '終助詞')) {
      const lbl = CONJ_SENTENCE_MAP[cur.surface_form];
      if (lbl) {
        const idx = prevContentIdx(k);
        if (idx >= 0) { out[idx].conj.push(lbl); cur.markTarget = out[idx]; }
        cur.markConj.push(lbl);
      }
      continue;
    }

    // 副助詞 (だけ/ばかり/のみ/など…) → also attaches to the nearest preceding
    // content word (can follow a verb, not just a noun).
    if (posDetailHas(cur, '副助詞')) {
      const lbl = CONJ_ADVERBIAL_MAP[cur.surface_form];
      if (lbl) {
        const idx = prevContentIdx(k);
        if (idx >= 0) { out[idx].conj.push(lbl); cur.markTarget = out[idx]; }
        cur.markConj.push(lbl);
      }
      continue;
    }

    // 係助詞 members that behave like restrictive/adverbial particles rather
    // than noun-marking ones like は/も — real IPADIC classifies しか/さえ/こそ
    // as 係助詞 despite their だけ-like function, so they're keyed off
    // CONJ_ADVERBIAL_MAP here instead of falling into the noun-only
    // case-particle branch below.
    if (posDetailHas(cur, '係助詞') && CONJ_ADVERBIAL_MAP[cur.surface_form]) {
      const lbl = CONJ_ADVERBIAL_MAP[cur.surface_form];
      const idx = prevContentIdx(k);
      if (idx >= 0) { out[idx].conj.push(lbl); cur.markTarget = out[idx]; }
      cur.markConj.push(lbl);
      continue;
    }

    // 接続助詞 (ながら/けど/し/ので/のに/ば…, linking two clauses) → attaches to
    // the nearest preceding content word. て/で never reach here — they're
    // already merged/consumed by the dedicated te-form handling above.
    if (posDetailHas(cur, '接続助詞')) {
      const lbl = CONJ_CONJUNCTIVE_MAP[cur.surface_form];
      if (lbl) {
        const idx = prevContentIdx(k);
        if (idx >= 0) { out[idx].conj.push(lbl); cur.markTarget = out[idx]; }
        cur.markConj.push(lbl);
      }
      continue;
    }

    // 並立助詞 (たり/や/とか, coordinating/listing particle) → same attachment.
    if (posDetailHas(cur, '並立助詞')) {
      const lbl = CONJ_PARALLEL_MAP[cur.surface_form];
      if (lbl) {
        const idx = prevContentIdx(k);
        if (idx >= 0) { out[idx].conj.push(lbl); cur.markTarget = out[idx]; }
        cur.markConj.push(lbl);
      }
      continue;
    }

    // 係助詞 (は/が/も) can mark contrast/topic on an adjective or verb too
    // (面白くはない "it's not that it's not interesting"), not just a noun —
    // broader attachment than 格助詞/連体化 below, which are genuinely noun-only.
    if (posDetailHas(cur, '係助詞')) {
      const lbl = CONJ_PARTICLE_MAP[cur.surface_form];
      if (lbl) {
        const idx = prevContentIdx(k);
        if (idx >= 0) { out[idx].conj.push(lbl); cur.markTarget = out[idx]; }
        cur.markConj.push(lbl);
      }
      continue;
    }

    // Case/binding particle (を/に/で/へ/と/から/まで/の/より…) → its grammatical
    // role, attached to the nearest preceding 名詞. Walks back past any small
    // particle sitting in between (誰{noun}か{indefinite}は{topic} — か isn't a
    // content word, so prevContentIdx correctly skips over it), not just the
    // immediately-adjacent token, since noun+か/だけ+は is common.
    if (CONJ_PARTICLE_DETAILS.some(d => posDetailHas(cur, d))) {
      const idx = prevContentIdx(k);
      if (idx >= 0 && out[idx].pos === '名詞') {
        const lbl = CONJ_PARTICLE_MAP[cur.surface_form];
        if (lbl) {
          out[idx].conj.push(lbl);
          cur.markConj.push(lbl);
          cur.markTarget = out[idx];
        }
      }
    }
  }

  return out;
}

function parseVTT(text) {
  const lines = [];
  for (const block of text.split(/\n\n+/)) {
    const bl = block.trim().split('\n');
    const ti = bl.findIndex(l => l.includes('-->'));
    if (ti < 0) continue;
    const txt = bl.slice(ti + 1)
      .map(l => l
        .replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, '') // strip furigana readings BEFORE other tags
        .replace(/<rp[^>]*>[\s\S]*?<\/rp>/gi, '')
        .replace(/<[^>]+>/g, '')                  // strip remaining tags
        .trim()
      )
      .filter(Boolean).join(' ');
    if (txt) lines.push(txt);
  }
  return lines.join('\n');
}

// Parse a VTT transcript into timed cues (start/end in ms, furigana-stripped text).
// Used by the sidebar to attach a timestamp to each grammar-point example so
// clicking it can seek the video, without touching each site's own VTT→overlay
// cue parser (which has separate timing/formatting needs).
function mcParseVTTCues(vttText) {
  const cues = [];
  const toMs = str => {
    const s = str.trim().split(/\s/)[0].replace(/,/, '.');
    const parts = s.split(':').map(Number);
    const [h, m, sec] = parts.length === 3 ? parts : [0, ...parts];
    return Math.round((h * 3600 + m * 60 + sec) * 1000);
  };
  for (const block of vttText.split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    const ti = lines.findIndex(l => l.includes('-->'));
    if (ti < 0) continue;
    const [startStr, endStr] = lines[ti].split(/\s*-->\s*/);
    const text = lines.slice(ti + 1)
      .map(l => l
        .replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, '')
        .replace(/<rp[^>]*>[\s\S]*?<\/rp>/gi, '')
        .replace(/<[^>]+>/g, '')
        .trim()
      )
      .filter(Boolean).join(' ');
    if (!text) continue;
    const start = toMs(startStr);
    const end = toMs(endStr);
    if (isNaN(start) || isNaN(end)) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

function _chromeGet(keys) {
  return new Promise(resolve => {
    if (!chrome.runtime?.id) { resolve({}); return; }
    try {
      chrome.storage.local.get(keys, d => {
        if (chrome.runtime.lastError) { resolve({}); return; }
        resolve(d);
      });
    } catch { resolve({}); }
  });
}

// Extract the item string, stripping prefix/suffix markers (〜様 → 様, 再〜 → 再).
function _vocabItem(v) {
  const s = typeof v === 'string' ? v : (v?.item || '');
  return s.replace(/^〜|〜$/g, '');
}

function _vocabIsApprentice(v) {
  // Only new-API object-format items can be apprentice.
  if (typeof v !== 'object' || !v || !v.item) return false;
  // status: 0 = learning, 1 = suspended, 2 = known.
  // Only learning (0) items can be apprentice.
  if (v.status !== 0) return false;
  // SRS levels 1–4 = apprentice. Levels 5+ are graduated.
  const lv = parseInt(v.level);
  return lv >= 1 && lv <= 4;
}

function getVocab() {
  return _chromeGet(['mm_vocab', 'mm_extra_vocab', 'mm_extra_kanji', 'mc_user_known', 'mc_show_apprentice']).then(d => {
    const showAppr = d.mc_show_apprentice || false;
    const set = new Set();
    for (const v of (d.mm_vocab || [])) {
      // Exclude apprentice words only when apprentice highlighting is on;
      // otherwise treat them as known.
      if (!showAppr || !_vocabIsApprentice(v)) set.add(_vocabItem(v));
    }
    for (const v of (d.mm_extra_vocab || [])) set.add(_vocabItem(v));
    for (const k of (d.mm_extra_kanji || [])) set.add(_vocabItem(k));
    for (const w of (d.mc_user_known  || [])) set.add(_vocabItem(w));
    return set;
  });
}

// Returns Set of words in the SRS pipeline (status ≠ 2/known, level 1–4).
function getApprenticeVocab() {
  return _chromeGet(['mm_vocab', 'mm_kanji']).then(d => {
    const set = new Set();
    for (const arr of [d.mm_vocab || [], d.mm_kanji || []]) {
      for (const v of arr) {
        // Uses same logic as _vocabIsApprentice
        if (_vocabIsApprentice(v)) set.add(_vocabItem(v));
      }
    }
    return set;
  });
}

// Returns Map of word → {level, status} for hover tooltip display.
function getWordStatusMap() {
  return _chromeGet(['mm_vocab', 'mm_kanji']).then(d => {
    const map = new Map();
    for (const arr of [d.mm_vocab || [], d.mm_kanji || []]) {
      for (const v of arr) {
        if (typeof v === 'object' && v.item) {
          const key = _vocabItem(v);
          const cur = map.get(key);
          if (!cur || v.status === 2 || v.status === 'known') map.set(key, { level: v.level, status: v.status });
        }
      }
    }
    return map;
  });
}

function getKanji() {
  return _chromeGet(['mm_kanji', 'mm_extra_kanji']).then(d => {
    const set = new Set();
    for (const k of (d.mm_kanji || [])) set.add(_vocabItem(k));
    for (const k of (d.mm_extra_kanji || [])) set.add(_vocabItem(k));
    return set;
  });
}

function _scoreKanji(tokens, kanjiSet) {
  const KANJI_RE = /[一-龯㐀-䶿]/g;
  const seen = new Set();
  let known = 0, total = 0;
  for (const tok of tokens) {
    if (!MM_CONTENT_POS.has(tok.pos)) continue;
    const w = tok.basic_form || tok.surface_form;
    for (const ch of (w.match(KANJI_RE) || [])) {
      if (seen.has(ch)) continue;
      seen.add(ch);
      total++;
      if (kanjiSet.has(ch)) known++;
    }
  }
  return { known, total };
}

function _scoreTokens(tokens, vocab) {
  let known = 0, total = 0;
  for (const tok of tokens) {
    if (!MM_CONTENT_POS.has(tok.pos)) continue;
    const w = tok.basic_form || tok.surface_form;
    if (!hasKanji(w) && [...w].length < 2) continue;
    total++;
    if (vocab.has(w) || vocab.has(tok.surface_form)) known++;
  }
  return { pct: total > 0 ? Math.round(100 * known / total) : null, known, total };
}

// Counts each unique content word once — returns { known, total } raw counts.
function _scoreTokensUnique(tokens, vocab) {
  const seen = new Set();
  let known = 0, total = 0;
  for (const tok of tokens) {
    if (!MM_CONTENT_POS.has(tok.pos)) continue;
    const w = tok.basic_form || tok.surface_form;
    if (!hasKanji(w) && [...w].length < 2) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    total++;
    if (vocab.has(w) || vocab.has(tok.surface_form)) known++;
  }
  return { known, total };
}

// Returns { score, freqKnown, freqTotal, uniqueKnown, uniqueTotal, kanjiKnown, kanjiTotal }
async function scoreText(rawText) {
  const [vocab, kanji] = await Promise.all([getVocab(), getKanji()]);
  if (!vocab.size || !rawText.trim()) return null;
  const tokenizer = await getTokenizer();
  const tokens = buildMergedTokens(tokenizer.tokenize(rawText), vocab);
  const { pct, known: fk, total: ft } = _scoreTokens(tokens, vocab);
  const { known: uk, total: ut } = _scoreTokensUnique(tokens, vocab);
  const { known: kk, total: kt } = _scoreKanji(tokens, kanji);
  return { score: pct, freqKnown: fk, freqTotal: ft, uniqueKnown: uk, uniqueTotal: ut, kanjiKnown: kk, kanjiTotal: kt };
}

// ── Watch / word history helpers ──────────────────────────────────────────────

async function saveVideoHistory(key, { title, url, site, score }) {
  try {
    if (!chrome.runtime?.id) return;
    const data = await chrome.storage.local.get(['mc_history_enabled', 'mc_video_history']);
    if (data.mc_history_enabled === false) return;
    const hist = data.mc_video_history || {};
    const prev = hist[key];
    hist[key] = { title: title || key, url, site, lastScore: score, lastWatched: Date.now(), watchCount: (prev?.watchCount || 0) + 1, firstWatched: prev?.firstWatched || Date.now() };
    await chrome.storage.local.set({ mc_video_history: hist });
  } catch {}
}

var _pendingWords = {};
var _wordFlushTimer = null;
async function trackUnknownWords(words) {
  try {
    if (!chrome.runtime?.id || !words?.length) return;
    for (const w of words) _pendingWords[w] = (_pendingWords[w] || 0) + 1;
    if (_wordFlushTimer) return;
    _wordFlushTimer = setTimeout(async () => {
      if (!chrome.runtime?.id) { _wordFlushTimer = null; return; }
      _wordFlushTimer = null;
      const batch = _pendingWords; _pendingWords = {};
      if (!Object.keys(batch).length) return;
      const data = await chrome.storage.local.get(['mc_history_enabled', 'mc_word_history']);
      if (data.mc_history_enabled === false) return;
      const hist = data.mc_word_history || {};
      const now = Date.now();
      for (const [w, cnt] of Object.entries(batch)) {
        if (!hist[w]) hist[w] = { count: 0, lastSeen: 0 };
        hist[w].count += cnt; hist[w].lastSeen = now;
      }
      await chrome.storage.local.set({ mc_word_history: hist });
    }, 5000);
  } catch {}
}

async function scoreVTT(vttText) {
  const [vocab, kanji] = await Promise.all([getVocab(), getKanji()]);
  if (!vocab.size) return null;
  const text = parseVTT(vttText);
  if (!text.trim()) return null;
  const tokenizer = await getTokenizer();
  const tokens = buildMergedTokens(tokenizer.tokenize(text), vocab);
  const { pct, known: fk, total: ft } = _scoreTokens(tokens, vocab);
  const { known: uk, total: ut } = _scoreTokensUnique(tokens, vocab);
  const { known: kk, total: kt } = _scoreKanji(tokens, kanji);
  return { score: pct, freqKnown: fk, freqTotal: ft, uniqueKnown: uk, uniqueTotal: ut, kanjiKnown: kk, kanjiTotal: kt };
}

function compColor(pct) {
  if (pct == null || !isFinite(pct)) return 'rgb(114,206,157)';
  const stops = [[237,121,137],[253,194,129],[114,206,157]];
  const t = Math.max(0, Math.min(100, pct)) / 100;
  const seg = t < 0.5 ? 0 : 1;
  const lt = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const [r1,g1,b1] = stops[seg], [r2,g2,b2] = stops[seg+1];
  return `rgb(${Math.round(r1+(r2-r1)*lt)},${Math.round(g1+(g2-g1)*lt)},${Math.round(b1+(b2-b1)*lt)})`;
}

// ── Immersion timer (auto video-time tracking) ────────────────────────────

var TIMER_DEFAULT_RESET_HOUR = 4;

function timerLogicalDay(ts, resetHour) {
  const d = new Date(ts - resetHour * 3600000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

var _timerResetHour = TIMER_DEFAULT_RESET_HOUR;
var _timerTrackingEnabled = true;
_chromeGet(['mc_timer_settings', 'mc_timer_tracking_enabled']).then(d => {
  if (d.mc_timer_settings?.resetHour != null) _timerResetHour = d.mc_timer_settings.resetHour;
  if (d.mc_timer_tracking_enabled === false) _timerTrackingEnabled = false;
});
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.mc_timer_settings) {
      _timerResetHour = changes.mc_timer_settings.newValue?.resetHour ?? TIMER_DEFAULT_RESET_HOUR;
    }
    if (changes.mc_timer_tracking_enabled) {
      _timerTrackingEnabled = changes.mc_timer_tracking_enabled.newValue !== false;
    }
  });
} catch {}

var _timerPendingSec = 0;
var _timerFlushTimer = null;
var _timerSite = null; // set once by startVideoTimeTracking — one video source per page
function _timerFlush() {
  _timerFlushTimer = null;
  const add = _timerPendingSec;
  _timerPendingSec = 0;
  if (add <= 0 || !chrome.runtime?.id) return;
  try {
    chrome.storage.local.get(['mc_timer_days', 'mc_timer_site_totals', 'mc_timer_source_days'], ({ mc_timer_days = {}, mc_timer_site_totals = {}, mc_timer_source_days = {} }) => {
      if (chrome.runtime.lastError) return;
      const day = timerLogicalDay(Date.now(), _timerResetHour);
      mc_timer_days[day] = (mc_timer_days[day] || 0) + add;
      if (_timerSite) {
        mc_timer_site_totals[_timerSite] = (mc_timer_site_totals[_timerSite] || 0) + add;
        mc_timer_source_days[_timerSite] = mc_timer_source_days[_timerSite] || {};
        mc_timer_source_days[_timerSite][day] = (mc_timer_source_days[_timerSite][day] || 0) + add;
      }
      chrome.storage.local.set({ mc_timer_days, mc_timer_site_totals, mc_timer_source_days });
    });
  } catch {}
}
function _timerAddSeconds(sec) {
  _timerPendingSec += sec;
  if (!_timerFlushTimer) _timerFlushTimer = setTimeout(_timerFlush, 3000);
}
window.addEventListener('pagehide', () => {
  if (_timerFlushTimer) { clearTimeout(_timerFlushTimer); _timerFlush(); }
});

// Lets any extension page (popup, stats page) show a "currently tracking"
// indicator without guessing which tab to check — they just read this
// timestamp from storage and treat it as live if it's recent. Throttled to
// one write per ~2s since it doesn't need per-second precision.
var _timerHeartbeatTimer = null;
function _timerHeartbeat() {
  if (_timerHeartbeatTimer || !chrome.runtime?.id) return;
  _timerHeartbeatTimer = setTimeout(() => { _timerHeartbeatTimer = null; }, 2000);
  try { chrome.storage.local.set({ mc_timer_last_active: Date.now() }); } catch {}
}

// Tracks real elapsed time while getVideoEl() returns a playing, visible video.
// Ignores background tabs and large gaps (throttled/suspended timers) so only
// genuine watch time accumulates into the daily immersion total. `site` is a
// short id (e.g. 'yt', 'cij', 'njk', 'player') used for the per-source breakdown.
var _timerIsRecording = false; // page-local: true while this tab is actively accumulating

function startVideoTimeTracking(getVideoEl, site) {
  _timerSite = site || null;
  let lastTick = null;
  setInterval(() => {
    if (!_timerTrackingEnabled) { lastTick = null; _timerIsRecording = false; return; }
    let video;
    try { video = getVideoEl(); } catch { video = null; }
    const backgrounded = document.hidden && document.pictureInPictureElement !== video;
    if (!video || video.paused || video.ended || backgrounded) { lastTick = null; _timerIsRecording = false; return; }
    _timerIsRecording = true;
    _timerHeartbeat();
    const now = Date.now();
    if (lastTick != null) {
      const delta = (now - lastTick) / 1000;
      if (delta > 0 && delta < 5) _timerAddSeconds(delta);
    }
    lastTick = now;
  }, 1000);
}

// ── Shared control-bar widgets ─────────────────────────────────────────────

// Immersion status dot for on-video control bars. Green glow = this tab is
// recording immersion time right now; grey = auto-detect on but idle;
// red = auto-detect disabled. Click toggles the global auto-detect setting.
function mcCreateTimerDotButton({ borderSide = 'right' } = {}) {
  const btn = document.createElement('button');
  btn.className = 'mc-timer-dot-btn';
  btn.style.cssText = [
    'padding:0 9px', 'background:none', 'border:none',
    `border-${borderSide}:1px solid rgba(255,255,255,.12)`,
    'cursor:pointer', 'display:flex', 'align-items:center',
  ].join(';');
  const dot = document.createElement('span');
  dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#666;transition:background .2s,box-shadow .2s';
  btn.appendChild(dot);

  const update = () => {
    if (!chrome.runtime?.id) return;
    if (!_timerTrackingEnabled) {
      dot.style.background = '#ED7989'; dot.style.boxShadow = 'none';
      btn.title = 'Immersion tracking disabled — click to enable';
    } else if (_timerIsRecording) {
      dot.style.background = '#72CE9D'; dot.style.boxShadow = '0 0 5px #72CE9D';
      btn.title = 'Recording immersion time — click to disable tracking';
    } else {
      dot.style.background = '#666'; dot.style.boxShadow = 'none';
      btn.title = 'Immersion auto-detect on (idle) — click to disable';
    }
  };
  update();
  setInterval(update, 1000);

  btn.addEventListener('click', e => {
    e.stopPropagation();
    try { chrome.storage.local.set({ mc_timer_tracking_enabled: !_timerTrackingEnabled }); } catch {}
  });
  return btn;
}

// Applies the user's preferred corner (mc_bar_position: tl/tr/bl/br) to an
// absolutely-positioned control bar, and live-updates when the setting changes.
function mcApplyBarPosition(bar) {
  const apply = pos => {
    const p = (pos === 'tr' || pos === 'bl' || pos === 'br') ? pos : 'tl';
    // 'auto' (not '') so stylesheet top/left rules can't fight the inline values
    bar.style.top = bar.style.bottom = bar.style.left = bar.style.right = 'auto';
    if (p[0] === 't') bar.style.top = '12px'; else bar.style.bottom = '80px';
    if (p[1] === 'l') bar.style.left = '12px'; else bar.style.right = '12px';
  };
  _chromeGet(['mc_bar_position']).then(d => apply(d.mc_bar_position));
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.mc_bar_position) apply(changes.mc_bar_position.newValue);
    });
  } catch {}
}

function showBadge(container, score, { top='10px', left='10px' } = {}) {
  let badge = container.querySelector('.jp-comp-badge');
  if (score === null) { if (badge) badge.remove(); return; }
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'jp-comp-badge';
    badge.style.cssText = [
      'position:absolute', `top:${top}`, `left:${left}`,
      'z-index:99999', 'pointer-events:none',
      'background:rgba(0,0,0,0.78)', 'color:#fff',
      'padding:4px 10px', 'border-radius:20px',
      "font:700 14px/1 -apple-system,'Helvetica Neue',sans-serif",
      'display:inline-flex', 'align-items:center', 'gap:6px',
      'width:max-content', 'white-space:nowrap', 'box-sizing:content-box',
    ].join(';');
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(badge);
  }
  const col = compColor(score);
  badge.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${col};display:inline-block;flex-shrink:0"></span>${score}%`;
}
