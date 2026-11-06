"""Lexical ranking for help articles: BM25 over normalised English, Hinglish and Hindi tokens.

Pure Python (no Django) so the CI eval can run it without a database. ``apps.helpkb.search`` fuses this
ranking with pgvector similarity; this half is what makes exact UI words ("Pipelines & Stages",
"API Keys") and Hinglish phrasings ("pipeline kaise banaye") land on the right article even when the
embedding model knows nothing about either.

Normalisation, in order:
1. phrase rewrites ("two factor" -> "2fa", "follow up" -> "followup", "log in" -> "login");
2. tokenise on letters/digits, keeping whole Devanagari words (combining vowel signs included);
3. drop stopwords in all three languages ("how", "kaise", "कैसे" carry no topic);
4. map synonyms and Hindi/Hinglish words onto one English canonical token ("banaye" -> "add");
5. a light suffix stemmer for English so "pipelines" and "pipeline" are one term.

The same function normalises articles and questions, so both sides always agree.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass

K1 = 1.2
B = 0.75
# BM25F field weights. Titles, questions and keywords say what the task *is*; the body mostly says how
# to do it, and mentions plenty of neighbouring features along the way.
WEIGHTS = {"title": 3.0, "question": 3.0, "keywords": 2.5, "menu_path": 0.8, "spotlight": 0.8, "body": 0.6}
# Per-field length normalisation: short fields are not penalised for being short.
FIELD_B = {"title": 0.5, "question": 0.5, "keywords": 0.4, "menu_path": 0.3, "spotlight": 0.0, "body": 0.75}
# The lexical half of the confidence gate (apps.helpkb.search adds the semantic half).
MIN_COVERAGE = 0.6
TITLE_MATCH_BOOST = 1.3
MIN_SCORE = 1.0

_TOKEN = re.compile(r"[a-z0-9]+|[ऀ-ॿ]+")
_PHRASES: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE), replacement)
    for pattern, replacement in (
        (r"two[\s-]*(factor|step)|2[\s-]*(factor|step)|\btfa\b|\bmfa\b|\botp\b|authenticator", " 2fa "),
        (r"टू[\s-]*फैक्टर|दो[\s-]*चरण", " 2fa "),
        (r"follow[\s-]*ups?", " followup "),
        (r"फॉलो[\s-]*अप", " followup "),
        (r"\bto[\s-]*dos?\b", " task "),
        (r"\b(log|sign)[\s-]*in\b", " login "),
        (r"\b(log|sign)[\s-]*out\b", " logout "),
        (r"\bsign[\s-]*up\b|\bregister\b", " signup "),
        (r"\be[\s-]*mail", " email"),
        (r"\bwhats[\s-]*app\b|\bwa\b", " whatsapp "),
        (r"\bapi[\s-]*keys?\b|\bapi[\s-]*token", " apikey "),
        (r"\bweb[\s-]*hooks?\b", " webhook "),
        (r"\bcustom[\s-]*fields?\b", " customfield "),
        (r"\bkan[\s-]*ban\b", " kanban "),
        (r"\bdrag\s*(and|&|n)\s*drop\b", " drag "),
        (r"\bpass[\s-]*word\b", " password "),
        (r"\bdark[\s-]*mode\b", " theme "),
        (
            r"\bturn(ed|s|ing)?\s+on\b|\bswitch(ed|es|ing)?\s+on\b|\bon\s+(kare|karen|karein|karu|karna|kaise)\b",
            " enable ",
        ),
        (
            r"\bturn(ed|s|ing)?\s+off\b|\bswitch(ed|es|ing)?\s+off\b|\boff\s+(kare|karen|karein|karna|kaise)\b",
            " disable ",
        ),
        (r"\bset[\s-]*up\b", " setup "),
        (r"\baudit[\s-]*(logs?|trail)\b|\bactivity\s*/\s*audit\b", " audit "),
        (r"\bget (it|them|him|her) back\b|\bbring (it|them) back\b|\bun[\s-]?delete\b|\bundo\b", " restore "),
        (r"\bapne\s*aap\b|\bautomatic(ally)?\b|\bauto\b|अपने\s*आप", " automation "),
        (r"\bwin\s*(percentage|percent|%|chance|probability)\b|\bprobability\b|\bpercentage\b", " probability "),
        (r"\bkeyboard\s*shortcuts?\b|\bshortcuts?\b|\bctrl\s*\+?\s*k\b", " shortcut "),
        (r"\b\d+[\s-]*digit\s*code\b|\bverification\s*code\b|\bsecurity\s*code\b", " 2fa "),
        (r"\bon (the )?(phone|mobile)\b|\bphone pe\b|\bmobile pe\b|\bsmall screen\b", " mobile "),
        (r"\bwhat('?s| is) the difference between\b|\bdifference between\b", " compare "),
        (r"\btake away\b|\brevoke\b|\bcut off\b", " remove "),
        (
            r"\b(as|into|to) (a )?(paying )?customers?\b|\bcustomer stage\b|\blifecycle\b",
            " contact customer lifecycle ",
        ),
        (r"\b(from )?(any|every) (screen|page|where)\b|\banywhere\b|\bhar (page|jagah)\b", " anywhere "),
        (r"\b(only|sirf|just) (my|meri|mere|mera)\b|\bmine only\b", " mine "),
        (r"\b(hit|reach|reached|exceed|exceeded|cross|crossed) (the |a |our )?(limit|maximum|max|\d+)", " limit "),
        (r"\bexcel\b|\bxlsx?\b|\bcsv\b|spreadsheet|एक्सेल", " spreadsheet "),
    )
)

_STOPWORDS = frozenset(
    unicodedata.normalize(
        "NFC",
        """
    a an the and or of to in on at for from with by as is are was were be been being am do does did done
    how what where when which who whom why can could should would will shall may might must i me my mine we
    our us you your he she it its they them their this that these those there here please kindly want need
    like just also into about any some all one get got go going let lets im i'm dont don't use using way ways
    able tell show guide help step steps crm workeasy workeasy360 app software system option button
    page thing something anything everything time hua hui huye hue raha rahi rahe gaya gayi gaye wahan
    aa aata aati likha likhi dikh dikha dikhta dikhti bol bola instead
    kaise kese kaisey kaisay kesy kaise kya kyu kyun kaha kahan kidhar karte karta karti kare karen karein karu
    karo karna karni karne kar hai hain ho hota hoti hote tha thi the ko se ka ki ke mein me main mai par pe
    aur ya bhi toh to hi jo yeh ye woh wo ek apna apne apni mera meri mere hum ham aap aapka aapki batao bataye
    bataiye bataen sakte sakta sakti chahiye chahta chahti mujhe muje hame hamein hume liye lie wala wali wale
    कैसे क्या कहाँ कहां करें करे करते करना करनी करने कर है हैं हो होता होती था थी को से का की के में मैं पर
    और या भी तो ही जो यह ये वह वो एक अपना अपने अपनी मेरा मेरी मेरे हम आप बताएं बताइए सकते सकता चाहिए मुझे
    लिए वाला वाली वाले किस कौन हुआ हुई हुए रहा रही गया गई सा सी
    """,
    ).split()
)

# Words that turn a question into "...on the page I am looking at".
DEICTIC = frozenset(
    unicodedata.normalize("NFC", "this here yahan yaha yahin idhar isme ismein यहाँ यहां इस इसमें इधर").split()
)
_DEICTIC_PHRASE = re.compile(r"\b(this|is)\s+(page|screen|tab|view|list)\b|\bone here\b", re.IGNORECASE)

# word -> canonical English token(s). Applied after stopwords, before stemming.
_SYNONYMS: dict[str, tuple[str, ...]] = {}


def _syn(canonical: str | tuple[str, ...], words: str) -> None:
    targets = canonical if isinstance(canonical, tuple) else (canonical,)
    for word in unicodedata.normalize("NFC", words).split():
        _SYNONYMS[word] = targets


_syn(
    "add",
    "put enter entering likhe likhen likhna लिखें लिखना add adding added create creating created new make making "
    "naya nayi naye banaye banaya banao banana banane banaun banau banayein banaen bnaye bnana daale daalo dale "
    "dalna बनाएं बनाएँ बनाये बनाना बनाओ नया नई नए जोड़ें जोड़े जोड़ना डालें",
)
_syn(("add", "link"), "jode jodo jodna jodein jodun जोड़")
_syn(
    "delete",
    "delete deleting deleted remove removing removed hataye hatao hatana hataen mitaye mitao हटाएं हटाना हटाओ मिटाएं "
    "डिलीट",
)
_syn(
    "edit",
    "edit editing edited change changing changed modify update updating updated badle badlo badalna badlen बदलें "
    "बदलना बदलो एडिट अपडेट",
)
_syn(("rename", "edit"), "rename renaming renamed naam नाम")
_syn(
    "view",
    "view viewing see open opening khole kholen kholna kholu dikhe dikhao dekhe dekho dekhna dekhen देखें देखना देखो खोलें",
)
_syn("search", "search searching find finding lookup khoje khojo khojna dhundhe dhundho dhundhna ढूंढें ढूँढें खोजें खोजना सर्च")
_syn("link", "link linking linked connect connecting connected associate attach attaching लिंक कनेक्ट")
_syn("move", "move moving moved shift drag aage आगे खिसकाएं मूव")
_syn("resolve", "resolve resolving resolved solve solved close closing closed hal हल बंद रिज़ॉल्व")
_syn("export", "export exporting exported download downloading nikale nikalna एक्सपोर्ट निर्यात डाउनलोड")
_syn("import", "import importing imported upload uploading इम्पोर्ट इंपोर्ट आयात अपलोड")
_syn("invite", "invite inviting invited bulaye bulao इनवाइट आमंत्रित बुलाएं")
_syn("schedule", "schedule scheduling scheduled book booking reschedule plan शेड्यूल")
_syn("remind", "remind reminder reminders yaad याद रिमाइंडर")
_syn("complete", "complete completing completed done finish finished mark पूरा")
_syn("contact", "contact contacts person people client clients sampark संपर्क कॉन्टैक्ट कांटेक्ट")
_syn("contact", "customer customers ग्राहक")
_syn(("contact", "lead"), "lead leads लीड")
_syn("company", "company companies organisation organization कंपनी")
_syn("pipeline", "pipeline pipelines पाइपलाइन")
_syn("stage", "stage stages column columns चरण स्टेज")
_syn("deal", "deal deals opportunity opportunities डील सौदा")
_syn("task", "task tasks kaam काम कार्य टास्क")
_syn("meeting", "meeting meetings मीटिंग बैठक")
_syn("call", "call calls spoke talked phoned कॉल")
_syn("activity", "activity activities गतिविधि एक्टिविटी")
_syn("tag", "tag tags label labels टैग")
_syn("favourite", "favourite favourites favorite favorites star starred पसंदीदा")
_syn("note", "note notes नोट")
_syn("file", "file files attachment attachments document documents फाइल फ़ाइल")
_syn("email", "email emails mail मेल ईमेल")
_syn("whatsapp", "whatsapp व्हाट्सएप व्हाट्सऐप वॉट्सऐप")
_syn("template", "template templates टेम्पलेट टेम्प्लेट")
_syn("user", "user users member members teammate employee staff यूज़र यूजर सदस्य")
_syn("team", "team teams टीम")
_syn("role", "role roles रोल भूमिका")
_syn("permission", "permission permissions access अनुमति एक्सेस")
_syn("password", "पासवर्ड")
_syn("setting", "setting settings सेटिंग सेटिंग्स")
_syn("dashboard", "dashboard डैशबोर्ड")
_syn("report", "report reports रिपोर्ट")
_syn("automation", "automation automations automate rule rules workflow workflows ऑटोमेशन")
_syn("notification", "notification notifications alert alerts सूचना नोटिफिकेशन")
_syn("integration", "integration integrations इंटीग्रेशन")
_syn("product", "product products item items प्रोडक्ट उत्पाद")
_syn("invoice", "invoice invoices bill billing subscription plan plans बिल बिलिंग प्लान")
_syn("calendar", "calendar कैलेंडर")
_syn("priority", "priority प्राथमिकता")
_syn("won", "won win जीता जीत")
_syn("filter", "filter filters फ़िल्टर फिल्टर")
_syn("ai", "ai assistant एआई")
_syn("audit", "audit ऑडिट")
_syn("profile", "profile प्रोफाइल प्रोफ़ाइल")
_syn("today", "today aaj आज")
_syn("overdue", "overdue late pending")
_syn("log", "log logging logged record recording recorded")
_syn("restore", "restore restoring restored recover recovering recovered")
_syn("ticket", "ticket tickets complaint complaints issue issues problem problems support query queries टिकट शिकायत")
_syn("assign", "assign assigning assigned allot give giving hand handover reassign sompe saunpe सौंपें असाइन")
_syn("price", "price prices pricing cost costs rate rates mrp कीमत दाम")
_syn("lost", "lost lose losing haara hara हारा हार")
_syn("verify", "verify verifying verified verification वेरिफाई सत्यापित")
_syn("denied", "denied forbidden blocked nahi nhi नहीं")
_syn("disable", "disable disabling disabled stop stopping mute unsubscribe band")
_syn("mobile", "mobile android iphone ios मोबाइल")
_syn("signup", "signup register registration")
_syn("delete", "offboard")
_syn("forecast", "forecast forecasting revenue projection अनुमान फोरकास्ट")


def _stem(word: str) -> str:
    if not word.isascii() or len(word) <= 3 or word.isdigit():
        return word
    for suffix, replacement in (("ies", "y"), ("ing", ""), ("ed", ""), ("es", ""), ("s", ""), ("e", "")):
        if word.endswith(suffix) and not (suffix == "s" and word.endswith("ss")):
            stemmed = word[: -len(suffix)] + replacement
            if len(stemmed) >= 3:
                return stemmed
    return word


def _phrases(text: str) -> str:
    text = text or ""
    for pattern, replacement in _PHRASES:
        text = pattern.sub(replacement, text)
    return text


def raw_tokens(text: str) -> list[str]:
    return _TOKEN.findall(_phrases(unicodedata.normalize("NFC", text or "")).lower())


def tokens(text: str) -> list[str]:
    out: list[str] = []
    for word in raw_tokens(text):
        if word in _STOPWORDS:
            continue
        for canonical in _SYNONYMS.get(word, (word,)):
            out.append(_stem(canonical))
    return out


def is_deictic(text: str) -> bool:
    return bool(_DEICTIC_PHRASE.search(text or "")) or any(word in DEICTIC for word in raw_tokens(text))


@dataclass
class Doc:
    id: str
    title: str
    question: str
    keywords: list[str]
    menu_path: str
    spotlight: str
    body: str
    route_path: str
    module: str = ""


@dataclass
class Hit:
    id: str
    score: float
    coverage: float


class Index:
    """An in-memory BM25F index. A few hundred articles index in a few milliseconds."""

    def __init__(self, docs: Iterable[Doc]):
        self.docs: dict[str, Doc] = {}
        self.fields: dict[str, dict[str, Counter[str]]] = {}
        self.lengths: dict[str, dict[str, int]] = {}
        df: Counter[str] = Counter()
        totals: Counter[str] = Counter()
        for doc in docs:
            fields = {name: tokens(text) for name, text in self._field_text(doc).items()}
            self.docs[doc.id] = doc
            self.fields[doc.id] = {name: Counter(terms) for name, terms in fields.items()}
            self.lengths[doc.id] = {name: len(terms) for name, terms in fields.items()}
            totals.update(self.lengths[doc.id])
            df.update({term for terms in fields.values() for term in terms})
        count = max(1, len(self.docs))
        self.avg = {name: max(1.0, totals[name] / count) for name in WEIGHTS}
        self.idf = {term: math.log(1 + (count - n + 0.5) / (n + 0.5)) for term, n in df.items()}

    @staticmethod
    def _field_text(doc: Doc) -> dict[str, str]:
        return {
            "title": doc.title,
            "question": doc.question,
            "keywords": " ".join(doc.keywords),
            "menu_path": doc.menu_path,
            "spotlight": doc.spotlight,
            "body": doc.body,
        }

    def _score(self, doc_id: str, terms: list[str]) -> tuple[float, int]:
        fields, lengths = self.fields[doc_id], self.lengths[doc_id]
        score, matched = 0.0, 0
        for term in terms:
            # BM25F: weighted, length-normalised term frequency summed across fields, saturated once.
            weighted = 0.0
            for name, weight in WEIGHTS.items():
                freq = fields[name].get(term, 0)
                if freq:
                    norm = 1 - FIELD_B[name] + FIELD_B[name] * lengths[name] / self.avg[name]
                    weighted += weight * freq / norm
            if weighted:
                matched += 1
                score += self.idf.get(term, 0.0) * weighted * (K1 + 1) / (weighted + K1)
        return score, matched

    def search(self, query: str, *, page: str = "", limit: int = 5) -> list[Hit]:
        terms = list(dict.fromkeys(tokens(query)))
        if not terms or not self.docs:
            return []
        page_path = (page or "").split("?", 1)[0].split("#", 1)[0].rstrip("/")
        deictic = is_deictic(query)
        hits: list[Hit] = []
        for doc_id in self.docs:
            score, matched = self._score(doc_id, terms)
            if not score:
                continue
            fields = self.fields[doc_id]
            if all(term in fields["title"] or term in fields["question"] for term in terms):
                # The article's own title or question is exactly about this: it is the task, not a mention.
                score *= TITLE_MATCH_BOOST
            route = self.docs[doc_id].route_path
            if page_path and route == page_path:
                score *= 2.2 if deictic else 1.15
            hits.append(Hit(id=doc_id, score=score, coverage=matched / len(terms)))
        hits.sort(key=lambda hit: (-hit.score, sum(self.lengths[hit.id].values())))
        return hits[:limit]


def is_confident(hit: Hit | None) -> bool:
    """Lexical evidence strong enough to answer from: most topic words matched, and a real score."""
    return hit is not None and hit.coverage >= MIN_COVERAGE and hit.score >= MIN_SCORE
