import { useEffect, useState } from 'react'
import './App.css'

let pdfJsLoader

const preciseCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
})

const number = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
})

const monthPattern =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'

const monthLabels = {
  apr: 'Apr',
  april: 'Apr',
  aug: 'Aug',
  august: 'Aug',
  dec: 'Dec',
  december: 'Dec',
  feb: 'Feb',
  february: 'Feb',
  jan: 'Jan',
  january: 'Jan',
  jul: 'Jul',
  july: 'Jul',
  jun: 'Jun',
  june: 'Jun',
  mar: 'Mar',
  march: 'Mar',
  may: 'May',
  nov: 'Nov',
  november: 'Nov',
  oct: 'Oct',
  october: 'Oct',
  sep: 'Sep',
  sept: 'Sep',
  september: 'Sep',
}

function getInitialTheme() {
  if (typeof window === 'undefined') {
    return 'dark'
  }

  const savedTheme = window.localStorage.getItem('sunrun-theme')

  if (savedTheme === 'light' || savedTheme === 'dark') {
    return savedTheme
  }

  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function parseKwhValue(value) {
  return Number(value.replace(/,/g, ''))
}

function getMonthLabel(value) {
  const key = value.toLowerCase()

  return monthLabels[key] || key.slice(0, 3)
}

function getPlausibleKwhValues(text, allowBareNumbers = false) {
  const values = [...text.matchAll(/(-?[\d,]+(?:\.\d+)?)\s*(?:kwh|kw-hours|kilowatt-hours)/gi)].map((match) =>
    parseKwhValue(match[1]),
  )

  if (!values.length && allowBareNumbers && /kwh|usage|net|delivered|used|consumption/i.test(text)) {
    return [...text.matchAll(/(?<![$\d.])-?[\d,]+(?:\.\d+)?(?!\s*(?:days?|%|¢|cents?))/gi)]
      .map((match) => parseKwhValue(match[0]))
      .filter((value) => Math.abs(value) >= 20 && Math.abs(value) <= 5000)
  }

  return values.filter((value) => Math.abs(value) >= 20 && Math.abs(value) <= 5000)
}

function extractMonthlyUsage(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const rows = []

  for (const line of lines) {
    const monthMatches = [...line.matchAll(new RegExp(monthPattern, 'gi'))]

    if (!monthMatches.length || /rate|price|charge|amount|due|payment|\$/i.test(line)) {
      continue
    }

    if (monthMatches.length === 1) {
      const values = getPlausibleKwhValues(line, true)

      if (!values.length) {
        continue
      }

      const rawMonth = monthMatches[0][1]

      rows.push({
        label: getMonthLabel(rawMonth),
        netKwh: line.toLowerCase().includes('net') ? values.at(-1) : values[0],
      })
    }

    if (monthMatches.length > 1) {
      for (let index = 0; index < monthMatches.length; index += 1) {
        const current = monthMatches[index]
        const next = monthMatches[index + 1]
        const segment = line.slice(current.index, next?.index)
        const values = getPlausibleKwhValues(segment, true)

        if (values.length) {
          rows.push({
            label: getMonthLabel(current[1]),
            netKwh: segment.toLowerCase().includes('net') ? values.at(-1) : values[0],
          })
        }
      }
    }
  }

  if (rows.length < 6) {
    const monthBlockRows = extractFlattenedMonthBlock(text)

    rows.push(...monthBlockRows)
  }

  const uniqueRows = []
  const seenLabels = new Map()

  for (const row of rows) {
    const key = row.label
    seenLabels.set(key, row)
  }

  for (const row of rows) {
    if (seenLabels.get(row.label) === row) {
      uniqueRows.push(row)
    }
  }

  return uniqueRows.slice(0, 12)
}

function extractFlattenedMonthBlock(text) {
  const normalized = text.replace(/\s+/g, ' ')
  const monthMatches = [...normalized.matchAll(new RegExp(monthPattern, 'gi'))]

  for (let start = 0; start < monthMatches.length; start += 1) {
    const candidates = monthMatches.slice(start, start + 12)
    const distinctLabels = [...new Set(candidates.map((match) => getMonthLabel(match[1])))]

    if (distinctLabels.length < 6) {
      continue
    }

    const firstIndex = candidates[0].index
    const lastIndex = candidates.at(-1).index

    if (lastIndex - firstIndex > 360) {
      continue
    }

    const afterMonths = normalized.slice(lastIndex, lastIndex + 1000)
    const values = getPlausibleKwhValues(afterMonths, true).slice(0, distinctLabels.length)

    if (values.length >= 6) {
      return distinctLabels.slice(0, values.length).map((label, index) => ({
        label,
        netKwh: values[index],
      }))
    }
  }

  return []
}

function buildFallbackMonths(kwhValues) {
  const monthlyValues = kwhValues.filter((value) => Math.abs(value) >= 50 && Math.abs(value) <= 5000)

  if (monthlyValues.length < 6) {
    return []
  }

  return monthlyValues.slice(0, 12).map((value, index) => ({
    label: `Month ${index + 1}`,
    netKwh: value,
  }))
}

function getAdvisorReply(prompt, analysis) {
  const message = prompt.toLowerCase()

  if (!analysis?.annualKwh) {
    return 'Upload a text-based PDF utility bill or paste the usage-history section first. Once I can see the kWh values, I will summarize annual net usage, high-use months, and whether the bill has enough detail for a solar sizing conversation.'
  }

  const peakMonth = analysis.months.length
    ? analysis.months.reduce(
        (peak, month) => (Math.abs(month.netKwh) > Math.abs(peak.netKwh) ? month : peak),
        analysis.months[0],
      )
    : null
  const averageMonthly = analysis.months.length ? analysis.annualKwh / analysis.months.length : 0

  if (message.includes('net') || message.includes('usage') || message.includes('kwh')) {
    if (!peakMonth) {
      return `This bill shows ${number.format(analysis.annualKwh)} kWh of annual net usage, but I did not find a full month-by-month table. Paste the usage history section if you want the 12-month breakdown.`
    }

    return `This bill shows ${number.format(analysis.annualKwh)} kWh of 12-month net usage. The average is about ${number.format(averageMonthly)} kWh per month, and the biggest month I found is ${peakMonth.label} at ${number.format(peakMonth.netKwh)} kWh.`
  }

  if (message.includes('month') || message.includes('breakdown')) {
    return `I found ${analysis.months.length} monthly usage rows. Use the 12-month breakdown to spot seasonal load: higher summer numbers usually point to cooling, and higher winter numbers usually point to heat, hot water, or electric appliances.`
  }

  if (message.includes('solar') || message.includes('size')) {
    return `For a solar conversation, lead with actual usage: ${number.format(analysis.annualKwh)} kWh per year from the utility bill. That annual number is the clean starting point before roof, shading, battery, or financing details.`
  }

  if (message.includes('rate') || message.includes('price') || message.includes('cost')) {
    if (analysis.pricePerKwh) {
      return `The bill works out to ${preciseCurrency.format(analysis.pricePerKwh)} per kWh paid. I calculated that by dividing ${preciseCurrency.format(analysis.totalElectricCharges)} in electric charges by ${number.format(Math.abs(analysis.usageForRate))} kWh of usage.`
    }

    return 'I could not calculate price per kWh yet. I need both total electric charges and kWh usage from the bill.'
  }

  return `Quick read: ${number.format(analysis.annualKwh)} kWh annual net usage, ${analysis.months.length} usage rows found, and parsing confidence is ${analysis.confidenceLabel.toLowerCase()}. Ask me about net usage, the month-by-month breakdown, or solar sizing.`
}

function parseBillText(text) {
  const normalized = text.replace(/\s+/g, ' ')
  const kwhMatches = [...normalized.matchAll(/(-?[\d,]+(?:\.\d+)?)\s*(?:kwh|kw-hours|kilowatt-hours)/gi)]
  const annualKwhMatches = [
    ...normalized.matchAll(
      /(?:annual|yearly|12\s*month|last\s*12\s*months|past\s*12\s*months|usage\s*history|net\s*usage)[^\d-]{0,80}(-?[\d,]+(?:\.\d+)?)\s*(?:kwh|kw-hours|kilowatt-hours)/gi,
    ),
    ...normalized.matchAll(
      /(-?[\d,]+(?:\.\d+)?)\s*(?:kwh|kw-hours|kilowatt-hours)[^a-z0-9]{0,50}(?:annual|yearly|12\s*month|last\s*12\s*months|past\s*12\s*months|net\s*usage)/gi,
    ),
  ]
  const dollarMatches = [
    ...normalized.matchAll(
      /(?:total amount due|amount due|new charges|current charges|total charges|please pay|balance due)[^\d$]{0,40}\$?\s*([\d,]+(?:\.\d{1,2})?)/gi,
    ),
  ]
  const electricChargeMatches = [
    ...normalized.matchAll(
      /(?:total\s+electric\s+charges?|electric\s+charges?|electricity\s+charges?|energy\s+charges?|delivery\s+and\s+supply|supply\s+charges?|generation\s+charges?)[^\d$]{0,60}\$?\s*([\d,]+(?:\.\d{1,2})?)/gi,
    ),
  ]
  const fallbackDollars = [...normalized.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)]
  const kwhValues = kwhMatches.map((match) => parseKwhValue(match[1]))
  const detectedMonths = extractMonthlyUsage(text)
  const months = detectedMonths.length >= 6 ? detectedMonths : buildFallbackMonths(kwhValues)
  const monthSource =
    detectedMonths.length >= 6
      ? 'usage table'
      : months.length >= 6
        ? 'fallback kWh sequence'
        : 'not found'
  const annualValues = annualKwhMatches
    .map((match) => parseKwhValue(match[1]))
    .filter((value) => Math.abs(value) >= 600 && Math.abs(value) <= 100000)
  const dollarValues = dollarMatches.length
    ? dollarMatches.map((match) => Number(match[1].replace(/,/g, '')))
    : fallbackDollars.map((match) => Number(match[1].replace(/,/g, '')))
  const electricChargeValues = electricChargeMatches.map((match) => Number(match[1].replace(/,/g, '')))
  const explicitAnnualKwh = annualValues.length
    ? annualValues.reduce((largest, value) => (Math.abs(value) > Math.abs(largest) ? value : largest), 0)
    : null
  const annualFromMonths = months.length ? months.reduce((total, month) => total + month.netKwh, 0) : null
  const monthlyKwh = months.length
    ? annualFromMonths / months.length
    : kwhValues.find((value) => Math.abs(value) >= 50 && Math.abs(value) <= 5000) || null
  const billAmount = dollarValues.length ? Math.max(...dollarValues.filter((value) => value < 5000)) : null
  const usableElectricCharges = electricChargeValues.filter((value) => value > 0 && value < 5000)
  const totalElectricCharges = usableElectricCharges.length ? Math.max(...usableElectricCharges) : billAmount
  const annualKwh = annualFromMonths || explicitAnnualKwh || (monthlyKwh ? monthlyKwh * 12 : null)
  const usageForRate = monthlyKwh || null
  const pricePerKwh =
    usageForRate && totalElectricCharges ? totalElectricCharges / Math.abs(usageForRate) : null
  const usageBasis = months.length >= 12
    ? `Found 12 monthly rows from ${monthSource}`
    : months.length >= 6
      ? `Found ${months.length} monthly rows from ${monthSource}`
      : explicitAnnualKwh
        ? 'Found annual net usage'
        : monthlyKwh
          ? 'Annualized current bill usage'
          : 'No usage found'
  const confidence = [months.length >= 6, annualKwh, totalElectricCharges, pricePerKwh].filter(Boolean).length
  const confidenceLabel = ['Waiting for bill', 'Low confidence', 'Good confidence', 'High confidence', 'Excellent confidence'][
    confidence
  ]

  return {
    annualKwh,
    billAmount,
    confidence,
    confidenceLabel,
    monthSource,
    monthlyKwh,
    months,
    pricePerKwh,
    totalElectricCharges,
    usageForRate,
    usageBasis,
  }
}

async function extractPdfText(file) {
  if (!pdfJsLoader) {
    pdfJsLoader = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.mjs?url'),
    ]).then(([pdfjsLib, worker]) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = worker.default
      return pdfjsLib
    })
  }

  const pdfjsLib = await pdfJsLoader
  const data = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const pageText = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const lines = new Map()

    for (const item of content.items) {
      const [, , , , x, y] = item.transform
      const lineKey = Math.round(y / 3) * 3
      const existing = lines.get(lineKey) || []

      existing.push({ text: item.str, x })
      lines.set(lineKey, existing)
    }

    const sortedLines = [...lines.entries()]
      .sort(([lineA], [lineB]) => lineB - lineA)
      .map(([, items]) =>
        items
          .sort((itemA, itemB) => itemA.x - itemB.x)
          .map((item) => item.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter(Boolean)

    pageText.push(sortedLines.join('\n'))
  }

  return pageText.join('\n')
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onerror = () => reject(new Error('The bill file could not be read.'))
    reader.onload = () => resolve(String(reader.result || ''))
    reader.readAsText(file)
  })
}

function App() {
  const [theme, setTheme] = useState(getInitialTheme)
  const [chatOpen, setChatOpen] = useState(true)
  const [chatDraft, setChatDraft] = useState('')
  const [chatMessages, setChatMessages] = useState([
    {
      role: 'assistant',
      text: 'Hi, I am your usage assistant. Upload a bill and I can explain the 12-month net usage, peak months, and what the utility data means.',
    },
  ])
  const [billText, setBillText] = useState('')
  const [billFileName, setBillFileName] = useState('')
  const [billAnalysis, setBillAnalysis] = useState(null)
  const [billSource, setBillSource] = useState('')
  const [billStatus, setBillStatus] = useState('')
  const [billError, setBillError] = useState('')
  const isLightMode = theme === 'light'

  useEffect(() => {
    window.localStorage.setItem('sunrun-theme', theme)
  }, [theme])

  const askAdvisor = (prompt) => {
    const cleanPrompt = prompt.trim()

    if (!cleanPrompt) {
      return
    }

    const reply = getAdvisorReply(cleanPrompt, billAnalysis)

    setChatMessages((messages) => [
      ...messages,
      { role: 'user', text: cleanPrompt },
      { role: 'assistant', text: reply },
    ])
    setChatDraft('')
    setChatOpen(true)
  }

  const analyzeBill = (text, fileName = '', source = '') => {
    const analysis = parseBillText(text)

    setBillText(text)
    setBillFileName(fileName)
    setBillAnalysis(analysis)
    setBillSource(source)
    setBillStatus(
      analysis.annualKwh
        ? 'Usage extracted from the utility bill.'
        : 'Bill loaded. I could not find utility usage yet.',
    )
    setBillError('')
  }

  const handleBillUpload = async (event) => {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    setBillStatus(isPdf ? 'Reading PDF bill...' : 'Reading bill file...')
    setBillError('')

    try {
      const text = isPdf ? await extractPdfText(file) : await readTextFile(file)

      if (text.trim().length < 20) {
        throw new Error(
          isPdf
            ? 'This PDF looks like a scanned image. Please upload a text-based PDF or paste the bill text from your utility account.'
            : 'This file does not contain enough bill text to analyze.',
        )
      }

      analyzeBill(text, file.name, isPdf ? 'PDF parsed locally' : 'Text file parsed locally')
    } catch (error) {
      setBillError(error.message)
      setBillStatus('')
      setBillFileName(file.name)
    } finally {
      event.target.value = ''
    }
  }

  return (
    <main className={`app extractor-app ${isLightMode ? 'light' : 'dark'}`}>
      <div className="topbar">
        <span>Usage extractor</span>
        <button
          aria-label={`Switch to ${isLightMode ? 'dark' : 'light'} mode`}
          aria-pressed={isLightMode}
          className="theme-toggle"
          type="button"
          onClick={() => setTheme((currentTheme) => (currentTheme === 'light' ? 'dark' : 'light'))}
        >
          <span className="theme-toggle-track">
            <span className="theme-toggle-thumb">{isLightMode ? '☀️' : '🌙'}</span>
          </span>
          <strong>{isLightMode ? 'Light' : 'Dark'}</strong>
        </button>
      </div>

      <section className="extractor-hero">
        <div className="hero-orbit" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="energy-ribbons" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="eyebrow">Utility bill intelligence</p>
        <h1>usage extractor</h1>
        <p>
          Upload a text-based utility PDF or paste bill text to extract 12 months of net kWh usage
          and turn the utility history into a clean customer-ready summary.
        </p>
      </section>

      <BillAnalyzer
        analysis={billAnalysis}
        billFileName={billFileName}
        billError={billError}
        billSource={billSource}
        billStatus={billStatus}
        billText={billText}
        onAnalyzeText={() => analyzeBill(billText, 'Pasted bill text', 'Pasted utility text')}
        onBillTextChange={setBillText}
        onUpload={handleBillUpload}
      />

      <SolarAdvisor
        analysis={billAnalysis}
        chatDraft={chatDraft}
        chatMessages={chatMessages}
        chatOpen={chatOpen}
        onAsk={askAdvisor}
        onDraftChange={setChatDraft}
        onToggle={() => setChatOpen((isOpen) => !isOpen)}
      />
    </main>
  )
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function MonthlyBreakdown({ months }) {
  if (!months.length) {
    return (
      <div className="empty-breakdown">
        <strong>No 12-month table found yet</strong>
        <span>Upload a bill with a usage history table, or paste the utility usage section.</span>
      </div>
    )
  }

  const maxUsage = Math.max(...months.map((month) => Math.abs(month.netKwh)), 1)

  return (
    <div className="usage-breakdown">
      {months.map((month, index) => {
        const width = `${Math.max(8, (Math.abs(month.netKwh) / maxUsage) * 100)}%`

        return (
          <div className="usage-row" key={`${month.label}-${index}`}>
            <span>{month.label}</span>
            <div className="usage-bar-track">
              <div
                className={month.netKwh < 0 ? 'usage-bar exported' : 'usage-bar'}
                style={{ width }}
              />
            </div>
            <strong>{number.format(month.netKwh)} kWh</strong>
          </div>
        )
      })}
    </div>
  )
}

function SolarAdvisor({ analysis, chatDraft, chatMessages, chatOpen, onAsk, onDraftChange, onToggle }) {
  const suggestions = [
    'Summarize net usage',
    'Explain the monthly breakdown',
    'Is this enough for solar sizing?',
  ]

  return (
    <aside className={chatOpen ? 'advisor open' : 'advisor'} aria-label="Usage AI assistant">
      <button className="advisor-toggle" type="button" onClick={onToggle}>
        <span className="advisor-orb">☀️</span>
        <span>{chatOpen ? 'Hide AI assistant' : 'Ask AI assistant'}</span>
      </button>

      {chatOpen && (
        <div className="advisor-window">
          <div className="advisor-header">
            <div>
              <p className="eyebrow">AI usage copilot</p>
              <h2>Usage Assistant</h2>
            </div>
            <span className="live-pill">{analysis?.annualKwh ? 'Bill loaded' : 'Waiting'}</span>
          </div>

          <div className="advisor-messages">
            {chatMessages.map((message, index) => (
              <div className={`message ${message.role}`} key={`${message.role}-${index}`}>
                {message.text}
              </div>
            ))}
          </div>

          <div className="suggestions">
            {suggestions.map((suggestion) => (
              <button type="button" key={suggestion} onClick={() => onAsk(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>

          <form
            className="advisor-form"
            onSubmit={(event) => {
              event.preventDefault()
              onAsk(chatDraft)
            }}
          >
            <input
              aria-label="Ask the usage assistant"
              placeholder="Ask about net usage, peak months, or solar sizing..."
              value={chatDraft}
              onChange={(event) => onDraftChange(event.target.value)}
            />
            <button type="submit">Send</button>
          </form>
        </div>
      )}
    </aside>
  )
}

function BillAnalyzer({
  analysis,
  billError,
  billFileName,
  billSource,
  billStatus,
  billText,
  onAnalyzeText,
  onBillTextChange,
  onUpload,
}) {
  const annualUsage = analysis?.annualKwh ? `${number.format(analysis.annualKwh)} kWh/year` : 'Not found'
  const averageUsage =
    analysis?.monthlyKwh && analysis.months.length
      ? `${number.format(analysis.monthlyKwh)} kWh/month`
      : 'Not found'

  return (
    <section className="panel bill-analyzer extractor-panel">
      <div className="section-title">
        <p className="eyebrow">Bill upload</p>
        <h2>Extract 12-month net usage</h2>
      </div>

      <div className="bill-grid">
        <label className="upload-zone">
          <span className="scan-line" aria-hidden="true" />
          <span className="upload-sparks" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <input
            accept=".pdf,.txt,.csv,.text,application/pdf"
            aria-label="Upload utility bill PDF or text file"
            type="file"
            onChange={onUpload}
          />
          <span className="upload-icon">📄</span>
          <strong>Upload utility bill</strong>
          <small>Text-based PDFs work in-browser. Scanned image PDFs need OCR or pasted text.</small>
        </label>

        <div className="bill-text-box">
          <textarea
            aria-label="Paste utility bill text"
            placeholder="Paste utility bill text here. Include the usage history table when possible: Jan 920 kWh, Feb 840 kWh, Mar 760 kWh..."
            value={billText}
            onChange={(event) => onBillTextChange(event.target.value)}
          />
          <button type="button" onClick={onAnalyzeText}>
            Analyze usage
          </button>
        </div>
      </div>

      {(billStatus || billError || billSource) && (
        <div className={billError ? 'bill-message error' : 'bill-message'}>
          <span>{billError || billStatus}</span>
          {billSource && !billError && <strong>{billSource}</strong>}
        </div>
      )}

      <div className="bill-results extractor-results">
        <Metric label="File" value={billFileName || 'No bill loaded'} />
        <Metric label="Annual net usage" value={annualUsage} />
        <Metric label="Average monthly net" value={averageUsage} />
        <Metric
          label="Electric charges"
          value={analysis?.totalElectricCharges ? preciseCurrency.format(analysis.totalElectricCharges) : 'Not found'}
        />
        <Metric
          label="Price paid per kWh"
          value={analysis?.pricePerKwh ? `${preciseCurrency.format(analysis.pricePerKwh)}/kWh` : 'Not found'}
        />
        <Metric label="Usage basis" value={analysis?.usageBasis || 'Waiting for bill'} />
        <Metric label="Parsing confidence" value={analysis?.confidenceLabel || 'Waiting for bill'} />
      </div>

      <div className="monthly-panel">
        <div className="section-title">
          <p className="eyebrow">12-month net usage</p>
          <h2>Month-by-month breakdown</h2>
        </div>
        <MonthlyBreakdown months={analysis?.months || []} />
      </div>
    </section>
  )
}

export default App
