import Groq from 'groq-sdk'

const SYSTEM_PROMPT = `You are MedBot, a friendly and empathetic medical assistant for a doctor booking app called Medbook.

Your job is to:
1. Ask the user about their symptoms in a warm, conversational way
2. Ask follow-up questions if needed to better understand (e.g., duration, severity, location)
3. Once you have enough information, recommend the most appropriate specialist

Available specialists:
- General physician (general illness, fever, cold, fatigue, checkup)
- Gynecologist (women's reproductive health, pregnancy, periods)
- Dermatologist (skin, hair, nail issues)
- Pediatrician (children under 18)
- Neurologist (headaches, seizures, memory issues, nerve problems)
- Gastroenterologist (stomach, digestion, bowel issues)

EMERGENCY SAFETY RULE:
If the user reports potentially life-threatening or red-flag emergency symptoms (such as severe chest pain/pressure, difficulty breathing, sudden numbness or paralysis, signs of stroke, coughing up blood, severe allergic reactions, or uncontrolled bleeding), IMMEDIATELY advise them to call local emergency services (e.g. 911/112) or go to the nearest emergency room without delay. Do NOT provide routine outpatient specialist recommendations for acute emergencies.

When you are ready to recommend a specialist, end your message with a JSON block in this exact format (on its own line):
RECOMMENDATION:{"speciality":"<speciality name>","reason":"<one sentence reason>"}

Rules:
- Be warm and reassuring, not clinical or scary
- Keep responses concise (2-4 sentences max before the recommendation)
- Only include the RECOMMENDATION JSON when you are confident about the speciality
- If you need more info, just ask a follow-up question without any JSON
- Always remind users this is for guidance only and not a medical diagnosis`

const analyzeSymptoms = async (req, res) => {
  try {
    const { messages } = req.body

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, message: 'Messages must be a non-empty array' })
    }

    const isValid = messages.every(
      m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0
    )

    if (!isValid) {
      return res.status(400).json({ success: false, message: 'Each message must have a valid role (user/assistant) and non-empty string content' })
    }

    if (!process.env.GROQ_API_KEY) {
      console.error('Chatbot error: GROQ_API_KEY is missing from environment variables')
      return res.status(500).json({ success: false, message: 'Chatbot service is temporarily unavailable. Please try again shortly.' })
    }

    const client = new Groq({ apiKey: process.env.GROQ_API_KEY })
    const model = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b'

    const response = await client.chat.completions.create({
      model,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
      ],
    })

    const text = response.choices?.[0]?.message?.content?.trim() || ''

    if (!text) {
      return res.status(502).json({ success: false, message: 'Received empty response from AI service' })
    }

    // Extract recommendation JSON if present
    const recMatch = text.match(/RECOMMENDATION:(\{[^}]+\})/)
    let recommendation = null
    let replyText = text

    if (recMatch) {
      try {
        recommendation = JSON.parse(recMatch[1])
        replyText = text.replace(/RECOMMENDATION:\{[^}]+\}/, '').trim()
      } catch {
        // If JSON parse fails, just show the text
      }
    }

    return res.json({ success: true, reply: replyText, recommendation })
  } catch (error) {
    console.error('Chatbot error details:', error)
    return res.status(500).json({ success: false, message: 'Chatbot service is temporarily unavailable. Please try again shortly.' })
  }
}

export { analyzeSymptoms }
