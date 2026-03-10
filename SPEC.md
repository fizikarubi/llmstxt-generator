# Project Brief: Automated llms.txt Generator Web App

## 1. Project Overview

- **Company Context:** Profound (an applied AI, data, and search company building marketing infrastructure for the generative internet). They value speed, craftsmanship, and clear communication.
- **Objective:** Develop a user-facing web application that accepts a website URL as input and automatically generates a standard-compliant `llms.txt` file by analyzing the site's structure and content.
- **Background:** `llms.txt` is a proposed standard (analogous to `robots.txt`) designed to provide structured information to Large Language Models (LLMs) to help them better process web data.

## 2. Core Technical Requirements

1. **Web Crawler & Content Extractor:**
   - Must traverse the provided website URL.
   - Must identify key pages and extract relevant metadata (titles, descriptions, URLs).
2. **File Generation Logic:**
   - Must structure the extracted data strictly according to the `llms.txt` specification.
   - **Spec Standard:** [llmstxt.org](https://llmstxt.org/)
3. **Web Interface:**
   - Must be a web application where the user can directly input a URL and receive the generated file. UI/UX design is left to the developer's discretion.

## 3. Deliverables

- **Live Deployment:** A working, deployed version of the web app on any hosting platform.
- **Source Code:** A GitHub repository containing the complete codebase.
- **README.md:** Clear documentation covering setup, configuration, and deployment instructions.
- **Media:** Screenshots of the project OR a short demo video.

## 4. Evaluation Criteria

- **Functionality:** Accuracy of the generated `llms.txt` reflecting the source site's structure and content.
- **Code Quality:** Well-structured, readable, and maintainable codebase.
- **Documentation:** Clarity and comprehensiveness of setup/usage instructions.

## 5. Submission & Rules

- **Submission Method:** Create a GitHub repo and invite the following collaborators:
  `chazzhou`, `allapk19`, `sherman-grewal`, `joshuaprunty`, `nuarmstrong`, `rahibk`, `joeydotdev`, `kirk-xuhj`, `bgaleotti`, `fedeya`
- **Use of AI Tools:** Permitted, but the developer must thoroughly understand all generated code and be able to explain architecture, trade-offs, and implementation details during a presentation.
- **Timeline:** No strict limit. Quality, depth, and well-understood code are prioritized over speed.
- **Confidentiality:** The project brief itself must remain private, but the resulting codebase can be used as a personal portfolio project. Profound will fork the repo for internal evaluation/AI-scanning.

## 6. Reference Links

- **Official Spec:** https://llmstxt.org/
- **Directory/Examples (For reference only):** https://llmstxt.site/
- **Getting Started Guide:** https://llmstxthub.com/guides/getting-started-llms-txt
