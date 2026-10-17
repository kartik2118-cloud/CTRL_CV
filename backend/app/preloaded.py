"""
backend/app/preloaded.py
Preloaded video transcripts, lyrics, and multilingual translations.
Enables instant, accurate subtitle delivery for known demonstration and training videos,
while seamlessly falling back to live Groq Whisper STT + LLM translation for arbitrary videos.
"""

from typing import Optional, List, Dict, Any

PRELOADED_VIDEOS: Dict[str, Dict[str, Any]] = {
    # Rick Astley - Never Gonna Give You Up (Official Music Video) [dQw4w9WgXcQ]
    "dQw4w9WgXcQ": {
        "title": "Rick Astley - Never Gonna Give You Up",
        "segments": [
            {
                "start": 18.5,
                "end": 22.8,
                "text": "We're no strangers to love",
                "translations": {
                    "hi": "हम प्यार से अनजान नहीं हैं",
                    "mr": "आपण प्रेमासाठी अनोळखी नाही",
                    "ta": "நாம் காதலுக்கு புதியவர்கள் அல்ல",
                    "te": "మనం ప్రేమకు కొత్తవాళ్లం కాదు",
                    "es": "No somos extraños al amor",
                    "fr": "Nous ne sommes pas des inconnus pour l'amour",
                    "de": "Wir sind keine Fremden in der Liebe",
                    "en": "We're no strangers to love"
                }
            },
            {
                "start": 22.8,
                "end": 27.0,
                "text": "You know the rules and so do I",
                "translations": {
                    "hi": "तुम नियम जानते हो और मैं भी",
                    "mr": "तुम्हाला नियम माहीत आहेत आणि मलाही",
                    "ta": "விதிகள் உனக்கு தெரியும் எனக்கும் தெரியும்",
                    "te": "నీకు నియమాలు తెలుసు నాకు కూడా",
                    "es": "Conoces las reglas y yo también",
                    "fr": "Tu connais les règles et moi aussi",
                    "de": "Du kennst die Regeln und ich auch",
                    "en": "You know the rules and so do I"
                }
            },
            {
                "start": 27.0,
                "end": 31.2,
                "text": "A full commitment's what I'm thinking of",
                "translations": {
                    "hi": "मैं एक पूर्ण समर्पण के बारे में सोच रहा हूँ",
                    "mr": "मी पूर्ण समर्पणाचा विचार करत आहे",
                    "ta": "முழுமையான அர்ப்பணிப்பைப் பற்றி நான் யோசிக்கிறேன்",
                    "te": "నేను పూర్తి నిబద్ధత గురించి ఆలోచిస్తున్నాను",
                    "es": "Estoy pensando en un compromiso total",
                    "fr": "Je pense à un engagement total",
                    "de": "Ich denke an eine feste Bindung",
                    "en": "A full commitment's what I'm thinking of"
                }
            },
            {
                "start": 31.2,
                "end": 35.5,
                "text": "You wouldn't get this from any other guy",
                "translations": {
                    "hi": "तुम्हें यह किसी और से नहीं मिलेगा",
                    "mr": "हे तुम्हाला इतर कोणत्याही व्यक्तीकडून मिळणार नाही",
                    "ta": "வேறெந்த ஆணிடமிருந்தும் உனக்கு இது கிடைக்காது",
                    "te": "ఇది నీకు వేరే ఎవరి నుంచీ దొరకదు",
                    "es": "No conseguirías esto de ningún otro chico",
                    "fr": "Tu n'obtiendrais pas cela d'un autre gars",
                    "de": "Das würdest du von keinem anderen bekommen",
                    "en": "You wouldn't get this from any other guy"
                }
            },
            {
                "start": 35.5,
                "end": 39.8,
                "text": "I just wanna tell you how I'm feeling",
                "translations": {
                    "hi": "मैं बस तुम्हें बताना चाहता हूँ कि मैं कैसा महसूस कर रहा हूँ",
                    "mr": "मला फक्त तुला सांगायचे आहे की मला कसे वाटते आहे",
                    "ta": "என் உணர்வை உன்னிடம் சொல்ல விரும்புகிறேன்",
                    "te": "నా భావన ఎలా ఉందో నీకు చెప్పాలనుకుంటున్నాను",
                    "es": "Solo quiero decirte cómo me siento",
                    "fr": "Je veux juste te dire ce que je ressens",
                    "de": "Ich will dir nur sagen, wie ich mich fühle",
                    "en": "I just wanna tell you how I'm feeling"
                }
            },
            {
                "start": 39.8,
                "end": 43.2,
                "text": "Gotta make you understand",
                "translations": {
                    "hi": "तुम्हें समझाना ही होगा",
                    "mr": "तुला समजावून सांगावेच लागेल",
                    "ta": "உனக்கு புரிய வைக்க வேண்டும்",
                    "te": "నీకు అర్థమయ్యేలా చెప్పాలి",
                    "es": "Tengo que hacerte entender",
                    "fr": "Je dois te faire comprendre",
                    "de": "Ich muss es dir verständlich machen",
                    "en": "Gotta make you understand"
                }
            },
            {
                "start": 43.2,
                "end": 47.3,
                "text": "Never gonna give you up, never gonna let you down",
                "translations": {
                    "hi": "तुम्हें कभी नहीं छोड़ूँगा, कभी निराश नहीं करूँगा",
                    "mr": "तुला कधीही सोडणार नाही, कधीही निराश करणार नाही",
                    "ta": "உன்னை ஒருபோதும் கைவிட மாட்டேன், ஏமாற்ற மாட்டேன்",
                    "te": "నిన్ను ఎప్పటికీ వదులుకోను, ఎప్పటికీ నిరాశపరచను",
                    "es": "Nunca te voy a abandonar, nunca te voy a defraudar",
                    "fr": "Jamais je ne t'abandonnerai, jamais je ne te décevrai",
                    "de": "Werde dich niemals aufgeben, dich niemals im Stich lassen",
                    "en": "Never gonna give you up, never gonna let you down"
                }
            },
            {
                "start": 47.3,
                "end": 51.5,
                "text": "Never gonna run around and desert you",
                "translations": {
                    "hi": "कभी भागूँगा नहीं और तुम्हें अकेला नहीं छोड़ूँगा",
                    "mr": "कधीही पळून जाणार नाही आणि तुला एकटे सोडणार नाही",
                    "ta": "ஒருபோதும் ஓடிப் போய் உன்னைத் தனியாக விடமாட்டேன்",
                    "te": "ఎప్పటికీ పారిపోను, నిన్ను విడిచిపెట్టను",
                    "es": "Nunca voy a andar por ahí y abandonarte",
                    "fr": "Jamais je ne courrai partout pour t'abandonner",
                    "de": "Werde niemals herumlaufen und dich verlassen",
                    "en": "Never gonna run around and desert you"
                }
            },
            {
                "start": 51.5,
                "end": 55.8,
                "text": "Never gonna make you cry, never gonna say goodbye",
                "translations": {
                    "hi": "कभी तुम्हें रुलाऊँगा नहीं, कभी अलविदा नहीं कहूँगा",
                    "mr": "तुला कधीही रडवणार नाही, कधीही निरोप घेणार नाही",
                    "ta": "உன்னை ஒருபோதும் அழ வைக்க மாட்டேன், பிரியாவிடை சொல்ல மாட்டேன்",
                    "te": "నిన్ను ఎప్పటికీ ఏడ్పించను, ఎప్పటికీ వీడ్కోలు చెప్పను",
                    "es": "Nunca te voy a hacer llorar, nunca te voy a decir adiós",
                    "fr": "Jamais je ne te ferai pleurer, jamais je ne te dirai au revoir",
                    "de": "Werde dich niemals zum Weinen bringen, niemals Lebewohl sagen",
                    "en": "Never gonna make you cry, never gonna say goodbye"
                }
            },
            {
                "start": 55.8,
                "end": 60.5,
                "text": "Never gonna tell a lie and hurt you",
                "translations": {
                    "hi": "कभी झूठ नहीं बोलूँगा और तुम्हें चोट नहीं पहुँचाऊँगा",
                    "mr": "कधीही खोटे बोलणार नाही आणि तुला दुखावणार नाही",
                    "ta": "ஒருபோதும் பொய் சொல்லி உன்னைக் காயப்படுத்த மாட்டேன்",
                    "te": "ఎప్పటికీ అబద్ధం చెప్పి నిన్ను బాధపెట్టను",
                    "es": "Nunca voy a decir una mentira y lastimarte",
                    "fr": "Jamais je ne mentirai pour te blesser",
                    "de": "Werde niemals lügen und dir wehtun",
                    "en": "Never gonna tell a lie and hurt you"
                }
            },
            {
                "start": 68.5,
                "end": 73.0,
                "text": "We've known each other for so long",
                "translations": {
                    "hi": "हम एक दूसरे को बहुत समय से जानते हैं",
                    "mr": "आपण एकमेकांना खूप दिवसांपासून ओळखतो",
                    "ta": "நாம் ஒருவரை ஒருவர் நீண்ட காலமாக அறிந்துள்ளோம்",
                    "te": "మనం ఒకరినొకరు చాలా కాలంగా తెలుసుకున్నాము",
                    "es": "Nos conocemos desde hace tanto tiempo",
                    "fr": "Nous nous connaissons depuis si longtemps",
                    "de": "Wir kennen uns schon so lange",
                    "en": "We've known each other for so long"
                }
            },
            {
                "start": 73.0,
                "end": 77.2,
                "text": "Your heart's been aching but you're too shy to say it",
                "translations": {
                    "hi": "तुम्हारा दिल दुख रहा है लेकिन तुम कहने में शरमा रहे हो",
                    "mr": "तुझे मन दुखत आहे पण सांगायला तू लाजत आहेस",
                    "ta": "உன் இதயம் வலிக்கிறது ஆனால் சொல்ல தயங்குகிறாய்",
                    "te": "నీ హృదయం బాధపడుతోంది కానీ చెప్పడానికి సిగ్గుపడుతున్నావు",
                    "es": "Tu corazón ha estado doliendo pero eres demasiado tímido para decirlo",
                    "fr": "Ton cœur a souffert mais tu es trop timide pour le dire",
                    "de": "Dein Herz schmerzt, aber du bist zu schüchtern es zu sagen",
                    "en": "Your heart's been aching but you're too shy to say it"
                }
            },
            {
                "start": 77.2,
                "end": 81.5,
                "text": "Inside we both know what's been going on",
                "translations": {
                    "hi": "अंदर ही अंदर हम दोनों जानते हैं कि क्या चल रहा है",
                    "mr": "आतल्या आत आपल्या दोघांना माहीत आहे काय चालले आहे",
                    "ta": "உள்ளுக்குள் நாம் இருவருக்கும் என்ன நடக்கிறது என்று தெரியும்",
                    "te": "లోలోపల మన ఇద్దరికీ తెలుసు ఏం జరుగుతోందో",
                    "es": "Por dentro ambos sabemos lo que ha estado pasando",
                    "fr": "Au fond nous savons tous les deux ce qui se passe",
                    "de": "Tief im Inneren wissen wir beide, was los ist",
                    "en": "Inside we both know what's been going on"
                }
            },
            {
                "start": 81.5,
                "end": 85.8,
                "text": "We know the game and we're gonna play it",
                "translations": {
                    "hi": "हम खेल जानते हैं और हम इसे खेलने वाले हैं",
                    "mr": "आपल्याला खेळ माहीत आहे आणि आपण तो खेळणार आहोत",
                    "ta": "நமக்கு ஆட்டம் தெரியும், நாம் அதை விளையாடப் போகிறோம்",
                    "te": "మనకు ఆట తెలుసు, మనం దాన్ని ఆడబోతున్నాము",
                    "es": "Conocemos el juego y vamos a jugarlo",
                    "fr": "Nous connaissons le jeu et nous allons le jouer",
                    "de": "Wir kennen das Spiel und wir werden es spielen",
                    "en": "We know the game and we're gonna play it"
                }
            },
            {
                "start": 85.8,
                "end": 90.0,
                "text": "And if you ask me how I'm feeling",
                "translations": {
                    "hi": "और अगर तुम मुझसे पूछो कि मैं कैसा महसूस कर रहा हूँ",
                    "mr": "आणि जर तू मला विचारलेस की मला कसे वाटते आहे",
                    "ta": "நான் எப்படி உணர்கிறேன் என்று நீ என்னிடம் கேட்டால்",
                    "te": "నేను ఎలా భావిస్తున్నానो నువ్వు నన్ను అడిగితే",
                    "es": "Y si me preguntas cómo me siento",
                    "fr": "Et si tu me demandes comment je me sens",
                    "de": "Und wenn du mich fragst, wie ich mich fühle",
                    "en": "And if you ask me how I'm feeling"
                }
            },
            {
                "start": 90.0,
                "end": 93.5,
                "text": "Don't tell me you're too blind to see",
                "translations": {
                    "hi": "यह मत कहना कि तुम देखने के लिए बहुत अंधे हो",
                    "mr": "असे म्हणू नकोस की तुला काही दिसत नाही",
                    "ta": "பார்க்க முடியாத அளவுக்கு குருடாகிவிட்டாய் என்று சொல்லாதே",
                    "te": "చూడలేనంత గుడ్డివాడివి అని నాకు చెప్పకు",
                    "es": "No me digas que estás demasiado ciego para ver",
                    "fr": "Ne me dis pas que tu es trop aveugle pour voir",
                    "de": "Sag mir nicht, du seist zu blind, um es zu sehen",
                    "en": "Don't tell me you're too blind to see"
                }
            },
            {
                "start": 93.5,
                "end": 97.8,
                "text": "Never gonna give you up, never gonna let you down",
                "translations": {
                    "hi": "तुम्हें कभी नहीं छोड़ूँगा, कभी निराश नहीं करूँगा",
                    "mr": "तुला कधीही सोडणार नाही, कधीही निराश करणार नाही",
                    "ta": "உன்னை ஒருபோதும் கைவிட மாட்டேன், ஏமாற்ற மாட்டேன்",
                    "te": "నిన్ను ఎప్పటికీ వదులుకోను, ఎప్పటికీ నిరాశపరచను",
                    "es": "Nunca te voy a abandonar, nunca te voy a defraudar",
                    "fr": "Jamais je ne t'abandonnerai, jamais je ne te décevrai",
                    "de": "Werde dich niemals aufgeben, dich niemals im Stich lassen",
                    "en": "Never gonna give you up, never gonna let you down"
                }
            },
            {
                "start": 97.8,
                "end": 102.0,
                "text": "Never gonna run around and desert you",
                "translations": {
                    "hi": "कभी भागूँगा नहीं और तुम्हें अकेला नहीं छोड़ूँगा",
                    "mr": "कधीही पळून जाणार नाही आणि तुला एकटे सोडणार नाही",
                    "ta": "ஒருபோதும் ஓடிப் போய் உன்னைத் தனியாக விடமாட்டேன்",
                    "te": "ఎప్పటికీ పారిపోను, నిన్ను విడిచిపెట్టను",
                    "es": "Nunca voy a andar por ahí y abandonarte",
                    "fr": "Jamais je ne courrai partout pour t'abandonner",
                    "de": "Werde niemals herumlaufen und dich verlassen",
                    "en": "Never gonna run around and desert you"
                }
            },
            {
                "start": 102.0,
                "end": 106.2,
                "text": "Never gonna make you cry, never gonna say goodbye",
                "translations": {
                    "hi": "कभी तुम्हें रुलाऊँगा नहीं, कभी अलविदा नहीं कहूँगा",
                    "mr": "तुला कधीही रडवणार नाही, कधीही निरोप घेणार नाही",
                    "ta": "உன்னை ஒருபோதும் அழ வைக்க மாட்டேன், பிரியாவிடை சொல்ல மாட்டேன்",
                    "te": "నిన్ను ఎప్పటికీ ఏడ్పించను, ఎప్పటికీ వీడ్కోలు చెప్పను",
                    "es": "Nunca te voy a hacer llorar, nunca te voy a decir adiós",
                    "fr": "Jamais je ne te ferai pleurer, jamais je ne te dirai au revoir",
                    "de": "Werde dich niemals zum Weinen bringen, niemals Lebewohl sagen",
                    "en": "Never gonna make you cry, never gonna say goodbye"
                }
            },
            {
                "start": 106.2,
                "end": 111.0,
                "text": "Never gonna tell a lie and hurt you",
                "translations": {
                    "hi": "कभी झूठ नहीं बोलूँगा और तुम्हें चोट नहीं पहुँचाऊँगा",
                    "mr": "कधीही खोटे बोलणार नाही आणि तुला दुखावणार नाही",
                    "ta": "ஒருபோதும் பொய் சொல்லி உன்னைக் காயப்படுத்த மாட்டேன்",
                    "te": "ఎప్పటికీ అబద్ధం చెప్పि నిన్ను బాధపెట్టను",
                    "es": "Nunca voy a decir una mentira y lastimarte",
                    "fr": "Jamais je ne mentirai pour te blesser",
                    "de": "Werde niemals lügen und dir wehtun",
                    "en": "Never gonna tell a lie and hurt you"
                }
            }
        ]
    },

    # Me at the zoo [jNQXAC9IVRw]
    "jNQXAC9IVRw": {
        "title": "Me at the zoo",
        "segments": [
            {
                "start": 0.0,
                "end": 4.5,
                "text": "All right, so here we are in front of the elephants",
                "translations": {
                    "hi": "ठीक है, तो हम यहाँ हाथियों के सामने हैं",
                    "mr": "ठीक आहे, तर आपण इथे हत्तींच्या समोर आहोत",
                    "ta": "சரி, இப்போது நாம் யானைகளின் முன்னால் இருக்கிறோம்",
                    "te": "సరే, ఇక్కడ మనం ఏనుగుల ముందు ఉన్నాము",
                    "es": "Muy bien, aquí estamos frente a los elefantes",
                    "fr": "D'accord, nous voici devant les éléphants",
                    "en": "All right, so here we are in front of the elephants"
                }
            },
            {
                "start": 4.5,
                "end": 9.5,
                "text": "The cool thing about these guys is that they have really, really, really long trunks",
                "translations": {
                    "hi": "इन लोगों की सबसे अच्छी बात यह है कि इनकी सूंड सचमुच बहुत लंबी होती है",
                    "mr": "यांच्याबद्दल छान गोष्ट म्हणजे त्यांची सोंड खरोखर खूप लांब असते",
                    "ta": "இவர்களிடம் உள்ள அருமையான விஷயம் என்னவென்றால் மிக நீண்ட தும்பிக்கை உள்ளது",
                    "te": "వీటిలో అద్భుతమైన విషయం ఏమిటంటే వీటికి నిజంగా చాలా పొడవైన తొండాలు ఉన్నాయి",
                    "es": "Lo genial de estos tipos es que tienen trompas muy, muy largas",
                    "fr": "Ce qui est cool avec ces gars, c'est qu'ils ont de très, très longs troncs",
                    "en": "The cool thing about these guys is that they have really, really, really long trunks"
                }
            },
            {
                "start": 9.5,
                "end": 14.5,
                "text": "And that's cool. And that's pretty much all there is to say.",
                "translations": {
                    "hi": "और यह बहुत अच्छा है। और बस कहने के लिए इतना ही है।",
                    "mr": "आणि ते खूप छान आहे. आणि एवढेच सांगण्यासारखे आहे.",
                    "ta": "அது அருமை. சொல்ல வேண்டியது அவ்வளவுதான்.",
                    "te": "మరియు అది బాగుంది. చెప్పడానికి అంతే ఉంది.",
                    "es": "Y eso es genial. Y eso es prácticamente todo lo que hay que decir.",
                    "fr": "Et c'est cool. Et c'est à peu près tout ce qu'il y a à dire.",
                    "en": "And that's cool. And that's pretty much all there is to say."
                }
            }
        ]
    }
}


def normalize_video_id(raw_id: Optional[str]) -> Optional[str]:
    """Extracts clean YouTube video ID if URL or query string was passed."""
    if not raw_id or not isinstance(raw_id, str):
        return None
    raw = raw_id.strip()
    if "v=" in raw:
        try:
            return raw.split("v=")[1].split("&")[0]
        except Exception:
            pass
    if "youtu.be/" in raw:
        try:
            return raw.split("youtu.be/")[1].split("?")[0]
        except Exception:
            pass
    return raw


def get_preloaded_segments(
    video_id: Optional[str],
    chunk_start: float,
    duration: float = 2.5,
    target_lang: Optional[str] = None
) -> Optional[List[Dict[str, Any]]]:
    """
    Checks if video_id matches a preloaded video and returns any segments
    that overlap with [chunk_start, chunk_start + duration].
    Returns None if video_id is not preloaded or no segments overlap.
    """
    clean_id = normalize_video_id(video_id)
    if not clean_id or clean_id not in PRELOADED_VIDEOS:
        return None

    video_info = PRELOADED_VIDEOS[clean_id]
    chunk_end = chunk_start + duration

    matched: List[Dict[str, Any]] = []
    norm_target = (target_lang or "en").lower().strip()

    for seg in video_info["segments"]:
        s_start = seg["start"]
        s_end = seg["end"]

        # Check interval overlap: max(chunk_start, s_start) < min(chunk_end, s_end)
        # Or if chunk_start is very close to segment start within 1.0s tolerance
        overlaps = max(chunk_start, s_start) < min(chunk_end, s_end)
        proximity = abs(chunk_start - s_start) < 1.0

        if overlaps or proximity:
            trans_dict = seg.get("translations", {})
            chosen_trans = trans_dict.get(norm_target)
            if not chosen_trans:
                # Fallback to English or first available
                chosen_trans = trans_dict.get("en") or (list(trans_dict.values())[0] if trans_dict else seg["text"])

            matched.append({
                "text": seg["text"],
                "start": s_start,
                "end": s_end,
                "translation": chosen_trans,
                "target_lang": norm_target,
                "is_preloaded": True
            })

    return matched if matched else None
