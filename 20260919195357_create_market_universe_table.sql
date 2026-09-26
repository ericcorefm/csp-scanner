-- Market Discovery universe: broad list of U.S. optionable stocks
-- Independent from scan_universe (user's personal watchlist)

CREATE TABLE IF NOT EXISTS market_universe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL UNIQUE,
  company_name text,
  active boolean NOT NULL DEFAULT true,
  optionable boolean NOT NULL DEFAULT true,
  last_verified_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE market_universe ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read_market_universe" ON market_universe FOR SELECT
  TO anon, authenticated USING (true);

-- Seed with a broad set of liquid U.S. optionable stocks across sectors
-- Covers tech, financials, energy, consumer, industrials, biotech, etc.
INSERT INTO market_universe (ticker, company_name, active, optionable) VALUES
-- Tech / Semiconductors
('AAPL','Apple Inc.',true,true),
('MSFT','Microsoft Corporation',true,true),
('NVDA','NVIDIA Corporation',true,true),
('AMD','Advanced Micro Devices',true,true),
('INTC','Intel Corporation',true,true),
('MU','Micron Technology',true,true),
('QCOM','Qualcomm Incorporated',true,true),
('AVGO','Broadcom Inc.',true,true),
('TXN','Texas Instruments',true,true),
('MRVL','Marvell Technology',true,true),
-- Quantum / Next-gen computing
('RGTI','Rigetti Computing',true,true),
('QBTS','D-Wave Quantum',true,true),
('IONQ','IonQ Inc.',true,true),
-- Crypto / Blockchain / Mining
('MARA','Marathon Digital Holdings',true,true),
('RIOT','Riot Platforms',true,true),
('CIFR','Cipher Mining',true,true),
('WULF','TeraWulf Inc.',true,true),
('IREN','IREN Limited',true,true),
('APLD','Applied Digital',true,true),
('CLSK','CleanSpark',true,true),
('HUT','Hut 8 Mining',true,true),
('BITF','Bitfarms',true,true),
-- Fintech
('SOFI','SoFi Technologies',true,true),
('AFRM','Affirm Holdings',true,true),
('UPST','Upstart Holdings',true,true),
('SQ','Block Inc.',true,true),
('PYPL','PayPal Holdings',true,true),
('COIN','Coinbase Global',true,true),
('HOOD','Robinhood Markets',true,true),
-- EV / Clean Energy
('RIVN','Rivian Automotive',true,true),
('LCID','Lucid Group',true,true),
('FCEL','FuelCell Energy',true,true),
('PLUG','Plug Power',true,true),
('BLDP','Ballard Power',true,true),
('RUN','Sunrun Inc.',true,true),
('ENPH','Enphase Energy',true,true),
('SEDG','SolarEdge Technologies',true,true),
('SPWR','SunPower Corporation',true,true),
('ARRY','Array Technologies',true,true),
('NIO','NIO Inc.',true,true),
('XPEV','XPeng Inc.',true,true),
('CHPT','ChargePoint Holdings',true,true),
('BLNK','Blink Charging',true,true),
('EVGO','EVgo Inc.',true,true),
-- Biotech / Pharma
('BNTX','BioNTech SE',true,true),
('MRNA','Moderna Inc.',true,true),
('NVAX','Novavax Inc.',true,true),
('VKTX','Viking Therapeutics',true,true),
('SAVA','Cassava Sciences',true,true),
('CRBP','Corbus Pharmaceuticals',true,true),
('ATXS','Athersys Inc.',true,true),
('GILD','Gilead Sciences',true,true),
('REGN','Regeneron Pharmaceuticals',true,true),
('VRTX','Vertex Pharmaceuticals',true,true),
('BMRN','BioMarin Pharmaceutical',true,true),
('HALO','Halozyme Therapeutics',true,true),
-- Consumer / Retail
('TSLA','Tesla Inc.',true,true),
('AMZN','Amazon.com Inc.',true,true),
('META','Meta Platforms',true,true),
('GOOGL','Alphabet Inc.',true,true),
('NFLX','Netflix Inc.',true,true),
('DIS','Walt Disney Company',true,true),
('UBER','Uber Technologies',true,true),
('ABNB','Airbnb Inc.',true,true),
('SPOT','Spotify Technology',true,true),
('SNAP','Snap Inc.',true,true),
('PINS','Pinterest Inc.',true,true),
('ROKU','Roku Inc.',true,true),
('ETSY','Etsy Inc.',true,true),
('W','Wayfair Inc.',true,true),
('CHWY','Chewy Inc.',true,true),
('DKNG','DraftKings Inc.',true,true),
-- Financials
('JPM','JPMorgan Chase',true,true),
('BAC','Bank of America',true,true),
('WFC','Wells Fargo',true,true),
('GS','Goldman Sachs',true,true),
('MS','Morgan Stanley',true,true),
('C','Citigroup',true,true),
('SCHW','Charles Schwab',true,true),
('USB','U.S. Bancorp',true,true),
('PNC','PNC Financial',true,true),
('TFC','Truist Financial',true,true),
-- Energy / Oil
('XOM','Exxon Mobil',true,true),
('CVX','Chevron Corporation',true,true),
('COP','ConocoPhillips',true,true),
('EOG','EOG Resources',true,true),
('SLB','Schlumberger',true,true),
('MPC','Marathon Petroleum',true,true),
('PSX','Phillips 66',true,true),
('VLO','Valero Energy',true,true),
-- Industrials / Aerospace
('BA','Boeing Company',true,true),
('CAT','Caterpillar Inc.',true,true),
('GE','General Electric',true,true),
('LMT','Lockheed Martin',true,true),
('RTX','RTX Corporation',true,true),
('NOC','Northrop Grumman',true,true),
('GD','General Dynamics',true,true),
('DE','Deere & Company',true,true),
-- Telecom / Media
('T','AT&T Inc.',true,true),
('VZ','Verizon Communications',true,true),
('TMUS','T-Mobile US',true,true),
('CMCSA','Comcast Corporation',true,true),
-- Healthcare
('JNJ','Johnson & Johnson',true,true),
('PFE','Pfizer Inc.',true,true),
('MRK','Merck & Co.',true,true),
('ABBV','AbbVie Inc.',true,true),
('LLY','Eli Lilly',true,true),
('TMO','Thermo Fisher',true,true),
('ABT','Abbott Laboratories',true,true),
('DHR','Danaher Corporation',true,true),
-- Retail / Consumer Goods
('WMT','Walmart Inc.',true,true),
('HD','Home Depot',true,true),
('COST','Costco Wholesale',true,true),
('TGT','Target Corporation',true,true),
('LOW','Lowe''s Companies',true,true),
('NKE','Nike Inc.',true,true),
('SBUX','Starbucks Corporation',true,true),
('MCD','McDonald''s Corporation',true,true),
('PG','Procter & Gamble',true,true),
('KO','Coca-Cola Company',true,true),
('PEP','PepsiCo Inc.',true,true)
ON CONFLICT (ticker) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_market_universe_active_optionable
  ON market_universe (ticker) WHERE active = true AND optionable = true;