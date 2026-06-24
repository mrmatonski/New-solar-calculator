import { useEffect, useMemo, useState } from 'react'
import './App.css'

let pdfJsLoader

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const number = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
})

const presets = [
  {
    name: 'Conservative',
    bill: 210,
    solar: 175,
    increase: 4,
    battery: 0,
    taxCredit: 30,
  },
  {
    name: 'Typical family',
    bill: 285,
    solar: 195,
    increase: 6,
    battery: 35,
    taxCredit: 30,
  },
  {
    name: 'High usage',
    bill: 420,
    solar: 260,
    increase: 7,
    battery: 55,
    taxCredit: 30,
  },
]

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

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || 0, min), max)
}

function getAdvisorReply(prompt, model, inputs) {
  const message = prompt.toLowerCase()
  const breakEvenText =
    model.breakEven === undefined ? 'not within 25 years' : `around year ${model.breakEven}`
  const annualUsage = inputs.billAnalysis?.annualKwh

  if (message.includes('usage') || message.includes('kwh') || message.includes('power')) {
    if (annualUsage) {
      return `The uploaded bill points to about ${number.format(annualUsage)} kWh per year. That is the strongest utility-backed number to lead with because it comes from the customer's actual bill history, not a generic average.`
    }

    return 'I do not have an annual kWh number yet. Upload a text-based PDF utility bill or paste the usage history, and I will pull the annual power usage into the estimate.'
  }

  if (message.includes('battery')) {
    return `With the current setup, battery backup adds ${currency.format(inputs.batteryPayment)} per month and brings the fixed solar estimate to ${currency.format(model.solarMonthly)}/mo. I would frame it as resilience first: backup power, more control, and still a 25-year projected savings story of ${currency.format(model.lifetime.cumulativeSavings)}.`
  }

  if (message.includes('payback') || message.includes('break') || message.includes('even')) {
    return `The current estimate reaches break-even ${breakEvenText}. Through year ${inputs.selectedYear}, projected cumulative savings are ${currency.format(model.current.cumulativeSavings)}. If the customer wants faster payback, lower the solar payment, increase the utility bill assumption, or model a higher utility rate increase.`
  }

  if (message.includes('sell') || message.includes('pitch') || message.includes('explain')) {
    return `Try this: "Your utility bill can keep rising, but this solar estimate gives you a predictable ${currency.format(model.solarMonthly)}/mo plan. By year ${inputs.selectedYear}, the model shows ${currency.format(model.current.cumulativeSavings)} in projected savings, and over 25 years that grows to ${currency.format(model.lifetime.cumulativeSavings)}."`
  }

  if (message.includes('environment') || message.includes('carbon') || message.includes('tree')) {
    return `The environmental angle is strong here: this model estimates about ${number.format(model.co2Tons)} tons of CO2 avoided over 25 years, roughly comparable to ${number.format(model.trees)} trees. I would use that after the money story, not before it.`
  }

  if (message.includes('year') || message.includes('savings') || message.includes('save')) {
    return `At year ${inputs.selectedYear}, utility is projected at ${currency.format(model.current.utilityAnnual)} for that year versus ${currency.format(model.current.solarAnnual)} for solar. The year-${inputs.selectedYear} annual difference is ${currency.format(model.current.annualSavings)}, and cumulative projected savings are ${currency.format(model.current.cumulativeSavings)}.`
  }

  return `Here is the quick read: current utility bill is ${currency.format(inputs.monthlyBill)}/mo, solar plus battery is ${currency.format(model.solarMonthly)}/mo, break-even is ${breakEvenText}, and 25-year projected savings are ${currency.format(model.lifetime.cumulativeSavings)}. Ask me about payback, battery, environmental impact, or how to pitch this to a homeowner.`
}

function parseBillText(text) {
  const normalized = text.replace(/\s+/g, ' ')
  const kwhMatches = [...normalized.matchAll(/([\d,]+(?:\.\d+)?)\s*(?:kwh|kw-hours|kilowatt-hours)/gi)]
  const annualKwhMatches = [
    ...normalized.matchAll(
      /(?:annual|yearly|12\s*month|last\s*12\s*months|past\s*12\s*months|usage\s*history)[^\d]{0,80}([\d,]+(?:\.\d+)?)\s*(?:kwh|kw-hours|kilowatt-hours)/gi,
    ),
    ...normalized.matchAll(
      /([\d,]+(?:\.\d+)?)\s*(?:kwh|kw-hours|kilowatt-hours)[^a-z0-9]{0,40}(?:annual|yearly|12\s*month|last\s*12\s*months|past\s*12\s*months)/gi,
    ),
  ]
  const dollarMatches = [
    ...normalized.matchAll(
      /(?:total amount due|amount due|new charges|current charges|total charges|please pay|balance due)[^\d$]{0,40}\$?\s*([\d,]+(?:\.\d{1,2})?)/gi,
    ),
  ]
  const fallbackDollars = [...normalized.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)]

  const kwhValues = kwhMatches.map((match) => Number(match[1].replace(/,/g, '')))
  const monthlyCandidates = kwhValues.filter((value) => value >= 50 && value <= 5000)
  const annualValues = annualKwhMatches
    .map((match) => Number(match[1].replace(/,/g, '')))
    .filter((value) => value >= 600 && value <= 100000)
  const dollarValues = dollarMatches.length
    ? dollarMatches.map((match) => Number(match[1].replace(/,/g, '')))
    : fallbackDollars.map((match) => Number(match[1].replace(/,/g, '')))

  const explicitAnnualKwh = annualValues.length ? Math.max(...annualValues) : null
  const historyMonths = monthlyCandidates.slice(0, 12)
  const annualFromHistory =
    historyMonths.length >= 6 ? historyMonths.reduce((total, value) => total + value, 0) : null
  const monthlyKwh = monthlyCandidates.length ? Math.max(...monthlyCandidates) : null
  const billAmount = dollarValues.length ? Math.max(...dollarValues.filter((value) => value < 5000)) : null
  const rate = monthlyKwh && billAmount ? billAmount / monthlyKwh : null
  const annualKwh = explicitAnnualKwh || annualFromHistory || (monthlyKwh ? monthlyKwh * 12 : null)
  const usageBasis = explicitAnnualKwh
    ? 'Found annual utility usage'
    : annualFromHistory
      ? `Summed ${historyMonths.length} months of utility history`
      : monthlyKwh
        ? 'Annualized current bill usage'
        : 'No usage found'
  const confidence = [monthlyKwh, billAmount, rate, annualKwh].filter(Boolean).length

  return {
    annualKwh,
    billAmount,
    confidence,
    monthlyKwh,
    rate,
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
    pageText.push(content.items.map((item) => item.str).join(' '))
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
  const [monthlyBill, setMonthlyBill] = useState(285)
  const [solarPayment, setSolarPayment] = useState(195)
  const [batteryPayment, setBatteryPayment] = useState(35)
  const [utilityIncrease, setUtilityIncrease] = useState(6)
  const [taxCredit, setTaxCredit] = useState(30)
  const [selectedYear, setSelectedYear] = useState(12)
  const [chatOpen, setChatOpen] = useState(true)
  const [chatDraft, setChatDraft] = useState('')
  const [chatMessages, setChatMessages] = useState([
    {
      role: 'assistant',
      text: 'Hi, I am your solar savings advisor. Ask me how to explain the numbers, handle payback questions, or pitch battery backup.',
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

  const model = useMemo(() => {
    const solarMonthly = solarPayment + batteryPayment
    const years = Array.from({ length: 26 }, (_, year) => {
      const utilityAnnual = monthlyBill * 12 * (1 + utilityIncrease / 100) ** year
      const solarAnnual = solarMonthly * 12
      const annualSavings = utilityAnnual - solarAnnual

      return {
        year,
        utilityAnnual,
        solarAnnual,
        annualSavings,
      }
    })

    let cumulativeUtility = 0
    let cumulativeSolar = 0
    const cumulative = years.map((item) => {
      cumulativeUtility += item.utilityAnnual
      cumulativeSolar += item.solarAnnual
      const savingsBeforeCredit = cumulativeUtility - cumulativeSolar
      const creditValue = solarMonthly * 12 * (taxCredit / 100)

      return {
        ...item,
        cumulativeUtility,
        cumulativeSolar,
        cumulativeSavings: savingsBeforeCredit + creditValue,
      }
    })

    const current = cumulative[selectedYear]
    const lifetime = cumulative.at(-1)
    const breakEven = cumulative.find((item) => item.cumulativeSavings > 0)?.year
    const co2Tons = Math.round(6.8 * 25)
    const trees = Math.round(co2Tons * 16.5)

    return {
      solarMonthly,
      years: cumulative,
      current,
      lifetime,
      breakEven,
      co2Tons,
      trees,
      firstYearSavings: cumulative[0].annualSavings,
    }
  }, [batteryPayment, monthlyBill, selectedYear, solarPayment, taxCredit, utilityIncrease])

  const applyPreset = (preset) => {
    setMonthlyBill(preset.bill)
    setSolarPayment(preset.solar)
    setBatteryPayment(preset.battery)
    setUtilityIncrease(preset.increase)
    setTaxCredit(preset.taxCredit)
  }

  const askAdvisor = (prompt) => {
    const cleanPrompt = prompt.trim()

    if (!cleanPrompt) {
      return
    }

    const reply = getAdvisorReply(cleanPrompt, model, {
      batteryPayment,
      billAnalysis,
      monthlyBill,
      selectedYear,
    })

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
    setBillStatus(analysis.annualKwh ? 'Usage found from the utility bill.' : 'Bill loaded. Usage was not found yet.')
    setBillError('')

    if (analysis.billAmount) {
      setMonthlyBill(clamp(Math.round(analysis.billAmount), 80, 800))
    }

    if (analysis.monthlyKwh && analysis.billAmount) {
      const estimatedSolar = Math.round(Math.max(95, Math.min(650, analysis.billAmount * 0.72)))
      setSolarPayment(estimatedSolar)
    }
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
    <main className={`app ${isLightMode ? 'light' : 'dark'}`}>
      <div className="topbar">
        <span>Solar savings workspace</span>
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

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">SunRun savings simulator</p>
          <h1>Show homeowners the moment solar starts winning.</h1>
          <p>
            Compare rising utility bills against a fixed solar plan, model battery backup,
            estimate lifetime savings, and give customers a clean story they can understand
            in seconds.
          </p>
          <div className="hero-actions">
            <a href="#calculator" className="button primary">
              Build estimate
            </a>
            <a href="#results" className="button secondary">
              View results
            </a>
          </div>
        </div>

        <div className="hero-card">
          <span>25-year projected savings</span>
          <strong>{currency.format(model.lifetime.cumulativeSavings)}</strong>
          <p>
            Break-even:{' '}
            {model.breakEven === undefined ? 'not within 25 years' : `year ${model.breakEven}`}
          </p>
        </div>
      </section>

      <section className="preset-row" aria-label="Estimate presets">
        {presets.map((preset) => (
          <button type="button" key={preset.name} onClick={() => applyPreset(preset)}>
            <span>{preset.name}</span>
            <strong>{currency.format(preset.bill)}/mo utility</strong>
          </button>
        ))}
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

      <section className="calculator" id="calculator">
        <div className="panel controls">
          <div className="section-title">
            <p className="eyebrow">Customer inputs</p>
            <h2>Tune the estimate live</h2>
          </div>

          <Control
            label="Monthly utility bill"
            value={monthlyBill}
            min={80}
            max={800}
            prefix="$"
            onChange={(value) => setMonthlyBill(clamp(value, 80, 800))}
          />
          <Control
            label="Monthly solar payment"
            value={solarPayment}
            min={75}
            max={650}
            prefix="$"
            onChange={(value) => setSolarPayment(clamp(value, 75, 650))}
          />
          <Control
            label="Battery backup add-on"
            value={batteryPayment}
            min={0}
            max={200}
            prefix="$"
            onChange={(value) => setBatteryPayment(clamp(value, 0, 200))}
          />
          <Control
            label="Annual utility rate increase"
            value={utilityIncrease}
            min={0}
            max={12}
            suffix="%"
            onChange={(value) => setUtilityIncrease(clamp(value, 0, 12))}
          />
          <Control
            label="Incentive / tax credit estimate"
            value={taxCredit}
            min={0}
            max={40}
            suffix="%"
            onChange={(value) => setTaxCredit(clamp(value, 0, 40))}
          />
        </div>

        <div className="panel year-panel">
          <div className="section-title">
            <p className="eyebrow">Time machine</p>
            <h2>Year {selectedYear}</h2>
          </div>
          <input
            aria-label="Select projection year"
            type="range"
            min="0"
            max="25"
            value={selectedYear}
            onChange={(event) => setSelectedYear(Number(event.target.value))}
          />
          <div className="ticks">
            <span>Today</span>
            <span>5y</span>
            <span>10y</span>
            <span>15y</span>
            <span>20y</span>
            <span>25y</span>
          </div>
          <div className="mini-grid">
            <Metric label="Utility that year" value={currency.format(model.current.utilityAnnual)} />
            <Metric label="Solar that year" value={currency.format(model.current.solarAnnual)} />
            <Metric label="Annual delta" value={currency.format(model.current.annualSavings)} />
          </div>
        </div>
      </section>

      <section className="results" id="results">
        <div className="result-card utility-card">
          <p>Projected utility cost</p>
          <strong>{currency.format(model.current.cumulativeUtility)}</strong>
          <span>Through year {selectedYear}</span>
        </div>
        <div className="result-card solar-card">
          <p>Projected solar cost</p>
          <strong>{currency.format(model.current.cumulativeSolar)}</strong>
          <span>{currency.format(model.solarMonthly)}/mo fixed estimate</span>
        </div>
        <div className="result-card savings-card">
          <p>Total projected savings</p>
          <strong>{currency.format(model.current.cumulativeSavings)}</strong>
          <span>Includes modeled incentive value</span>
        </div>
      </section>

      <section className="panel chart-panel">
        <div className="section-title">
          <p className="eyebrow">25-year cost curve</p>
          <h2>Where the utility bill runs away</h2>
        </div>
        <div className="bars" aria-label="25-year utility and solar cost chart">
          {model.years.filter((item) => item.year % 5 === 0).map((item) => {
            const max = model.lifetime.cumulativeUtility
            const utilityHeight = `${Math.max(8, (item.cumulativeUtility / max) * 100)}%`
            const solarHeight = `${Math.max(8, (item.cumulativeSolar / max) * 100)}%`

            return (
              <div className="bar-group" key={item.year}>
                <div className="bar-stack">
                  <span className="bar utility-bar" style={{ height: utilityHeight }} />
                  <span className="bar solar-bar" style={{ height: solarHeight }} />
                </div>
                <p>Y{item.year}</p>
              </div>
            )
          })}
        </div>
      </section>

      <section className="insights">
        <article>
          <span>Payback signal</span>
          <strong>
            {model.breakEven === undefined ? 'Needs adjustment' : `Year ${model.breakEven}`}
          </strong>
          <p>Estimated point where cumulative solar savings turn positive.</p>
        </article>
        <article>
          <span>Carbon impact</span>
          <strong>{number.format(model.co2Tons)} tons</strong>
          <p>Estimated CO2 avoided across 25 years of residential solar production.</p>
        </article>
        <article>
          <span>Tree equivalent</span>
          <strong>{number.format(model.trees)}</strong>
          <p>A simple visual comparison customers can remember after the appointment.</p>
        </article>
      </section>

      <SolarAdvisor
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

function Control({ label, value, min, max, prefix = '', suffix = '', onChange }) {
  return (
    <label className="control">
      <span>{label}</span>
      <div className="input-wrap">
        {prefix && <small>{prefix}</small>}
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {suffix && <small>{suffix}</small>}
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
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

function SolarAdvisor({ chatDraft, chatMessages, chatOpen, onAsk, onDraftChange, onToggle }) {
  const suggestions = [
    'How do I pitch this?',
    'When is payback?',
    'Explain battery backup',
  ]

  return (
    <aside className={chatOpen ? 'advisor open' : 'advisor'} aria-label="Solar AI advisor">
      <button className="advisor-toggle" type="button" onClick={onToggle}>
        <span className="advisor-orb">☀️</span>
        <span>{chatOpen ? 'Hide AI advisor' : 'Ask AI advisor'}</span>
      </button>

      {chatOpen && (
        <div className="advisor-window">
          <div className="advisor-header">
            <div>
              <p className="eyebrow">AI sales copilot</p>
              <h2>Solar Advisor</h2>
            </div>
            <span className="live-pill">Live estimate</span>
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
              aria-label="Ask the solar advisor"
              placeholder="Ask about savings, payback, battery..."
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
  const confidenceLabel = ['Waiting for bill', 'Low confidence', 'Good confidence', 'High confidence'][
    analysis?.confidence || 0
  ]

  return (
    <section className="panel bill-analyzer">
      <div className="section-title">
        <p className="eyebrow">Bill scanner</p>
        <h2>Upload a bill and detect usage</h2>
      </div>

      <div className="bill-grid">
        <label className="upload-zone">
          <input
            accept=".pdf,.txt,.csv,.text,application/pdf"
            aria-label="Upload utility bill PDF or text file"
            type="file"
            onChange={onUpload}
          />
          <span className="upload-icon">📄</span>
          <strong>Upload PDF bill</strong>
          <small>Pulls kWh usage from text-based utility PDFs. Scanned image PDFs need OCR first.</small>
        </label>

        <div className="bill-text-box">
          <textarea
            aria-label="Paste utility bill text"
            placeholder="Or paste bill text here, then click Analyze. Example: Last 12 months usage 13,680 kWh, Total Amount Due $285.42..."
            value={billText}
            onChange={(event) => onBillTextChange(event.target.value)}
          />
          <button type="button" onClick={onAnalyzeText}>
            Analyze bill
          </button>
        </div>
      </div>

      {(billStatus || billError || billSource) && (
        <div className={billError ? 'bill-message error' : 'bill-message'}>
          <span>{billError || billStatus}</span>
          {billSource && !billError && <strong>{billSource}</strong>}
        </div>
      )}

      <div className="bill-results">
        <Metric label="File" value={billFileName || 'No bill loaded'} />
        <Metric
          label="Annual usage"
          value={analysis?.annualKwh ? `${number.format(analysis.annualKwh)} kWh/year` : 'Not found'}
        />
        <Metric
          label="Monthly usage"
          value={analysis?.monthlyKwh ? `${number.format(analysis.monthlyKwh)} kWh` : 'Not found'}
        />
        <Metric
          label="Bill amount"
          value={analysis?.billAmount ? currency.format(analysis.billAmount) : 'Not found'}
        />
        <Metric
          label="Estimated energy rate"
          value={analysis?.rate ? `${currency.format(analysis.rate * 100)}/100 kWh` : 'Not found'}
        />
        <Metric label="Usage basis" value={analysis?.usageBasis || 'Waiting for bill'} />
        <Metric label="Parsing confidence" value={confidenceLabel} />
      </div>
    </section>
  )
}

export default App
