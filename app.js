const API_BASE = 'https://opentdb.com';
const QUESTION_COUNT = 10;
const QUESTION_TIME = 30;
const MAX_NAME_LENGTH = 30;
const HIGH_SCORES_KEY = 'triviaHighScores';
const ANSWER_LETTERS = ['A', 'B', 'C', 'D'];
const TIMER_CIRCUMFERENCE = 2 * Math.PI * 19; // matches r="19" in the timer SVG
const REVEAL_DELAY = 1500;

// Fisher–Yates shuffle (unbiased, unlike sort(() => Math.random() - 0.5))
function shuffle(items) {
    const arr = [...items];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Small helper to build DOM nodes safely. Text is always set via textContent,
// so data from the API or from players can never be interpreted as HTML.
function el(tag, { className, text } = {}, children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    children.forEach(child => node.appendChild(child));
    return node;
}

function playSound(audio) {
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().catch(() => { /* autoplay blocked or not loaded; ignore */ });
}

function resultMessage(score, total) {
    const ratio = total ? score / total : 0;
    if (ratio === 1) return { emoji: '🏆', title: 'Perfect game!', subtitle: 'Flawless. Take a bow.' };
    if (ratio >= 0.8) return { emoji: '🚀', title: 'Out of this world!', subtitle: 'That was a stellar run.' };
    if (ratio >= 0.5) return { emoji: '🎉', title: 'Nice work!', subtitle: 'Solid score. Can you beat it?' };
    if (ratio >= 0.3) return { emoji: '💪', title: 'Good effort!', subtitle: 'Practice makes perfect.' };
    return { emoji: '🌱', title: 'Keep going!', subtitle: 'Every expert started somewhere.' };
}

class TriviaGame {
    constructor() {
        this.questions = [];
        this.results = [];
        this.answerButtons = [];
        this.currentQuestion = 0;
        this.score = 0;
        this.timer = null;
        this.advanceTimeout = null;
        this.timeLeft = QUESTION_TIME;
        this.playerName = '';
        this.categories = [];
        this.selectedCategory = '';
        this.sessionToken = null;
        this.lastEntryId = null;

        this.tickSound = document.getElementById('tick-sound');
        this.correctSound = document.getElementById('correct-sound');
        this.wrongSound = document.getElementById('wrong-sound');
        this.timeoutSound = document.getElementById('timeout-sound');

        this.initializeGame();
    }

    async initializeGame() {
        this.setupEventListeners();
        this.showStartScreen();
        await this.loadCategories();
    }

    async fetchJson(url) {
        const response = await fetch(url, { referrerPolicy: 'no-referrer' });
        if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`);
        }
        return response.json();
    }

    async loadCategories() {
        try {
            const data = await this.fetchJson(`${API_BASE}/api_category.php`);
            this.categories = Array.isArray(data.trivia_categories) ? data.trivia_categories : [];
        } catch (error) {
            console.error('Error loading categories:', error);
            this.categories = [];
        }
        this.populateCategorySelect();
    }

    populateCategorySelect() {
        const select = document.getElementById('category');
        const anyOption = el('option', { text: 'Any category' });
        anyOption.value = '';
        select.replaceChildren(anyOption);
        this.categories.forEach(category => {
            const option = el('option', { text: category.name });
            option.value = String(category.id);
            select.appendChild(option);
        });
    }

    setupEventListeners() {
        document.getElementById('player-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleGameStart();
        });

        document.getElementById('play-again').addEventListener('click', () => {
            this.showStartScreen();
        });

        document.getElementById('view-scores').addEventListener('click', () => {
            this.showHighScores({ showSummary: false });
        });

        document.getElementById('clear-scores').addEventListener('click', () => {
            if (window.confirm('Clear all high scores?')) {
                this.clearHighScores();
            }
        });

        // Keyboard shortcuts: 1-4 or A-D to pick an answer.
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (document.getElementById('game-screen').classList.contains('hidden')) return;
            const key = e.key.toUpperCase();
            let index = ANSWER_LETTERS.indexOf(key);
            if (index === -1 && /^[1-4]$/.test(key)) index = Number(key) - 1;
            const entry = this.answerButtons[index];
            if (entry && !entry.button.disabled) {
                e.preventDefault();
                entry.button.click();
            }
        });
    }

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.add('hidden');
        });
        document.getElementById(screenId).classList.remove('hidden');
    }

    showStartScreen() {
        this.stopTimers();
        this.showScreen('start-screen');
        document.getElementById('player-name').focus({ preventScroll: true });
    }

    stopTimers() {
        clearInterval(this.timer);
        clearTimeout(this.advanceTimeout);
        this.timer = null;
        this.advanceTimeout = null;
    }

    async handleGameStart() {
        const name = document.getElementById('player-name').value.trim().slice(0, MAX_NAME_LENGTH);
        if (!name) return;

        this.playerName = name;
        const categoryValue = document.getElementById('category').value;
        // Only accept category ids that came from the API list.
        this.selectedCategory = this.categories.some(c => String(c.id) === categoryValue) ? categoryValue : '';

        document.getElementById('player-display').textContent = this.playerName;
        document.getElementById('player-avatar').textContent = [...this.playerName][0] || '?';
        this.currentQuestion = 0;
        this.score = 0;
        this.results = [];
        this.answerButtons = [];
        this.updateScoreDisplay(false);
        this.resetTimerDisplay();
        this.renderProgress(0);
        this.showScreen('game-screen');
        this.showMessage('Loading questions...', { spinner: true });

        try {
            await this.fetchQuestions();
            this.renderProgress(this.questions.length);
            this.renderQuestion();
        } catch (error) {
            console.error('Error fetching questions:', error);
            this.showMessage(error.userMessage || 'Could not load questions. Please check your connection and try again.', { backButton: true });
        }
    }

    async getSessionToken() {
        // A session token stops OpenTDB from repeating questions across games.
        if (this.sessionToken) return this.sessionToken;
        try {
            const data = await this.fetchJson(`${API_BASE}/api_token.php?command=request`);
            if (data.response_code === 0) this.sessionToken = data.token;
        } catch {
            // Tokens are optional; continue without one.
        }
        return this.sessionToken;
    }

    async fetchQuestions(retried = false) {
        const params = new URLSearchParams({
            amount: String(QUESTION_COUNT),
            type: 'multiple',
            // URL-encoded responses decode to plain text, so nothing needs to go through innerHTML.
            encode: 'url3986',
        });
        if (this.selectedCategory) params.set('category', this.selectedCategory);
        const token = await this.getSessionToken();
        if (token) params.set('token', token);

        const data = await this.fetchJson(`${API_BASE}/api.php?${params}`);

        switch (data.response_code) {
            case 0:
                break;
            case 3: // token not found
            case 4: // token exhausted: every question in this category has been seen
                this.sessionToken = null;
                if (!retried) return this.fetchQuestions(true);
                break;
            case 5: // rate limited: OpenTDB allows one request every 5 seconds
                if (!retried) {
                    await new Promise(resolve => setTimeout(resolve, 5500));
                    return this.fetchQuestions(true);
                }
                break;
        }

        if (data.response_code !== 0 || !Array.isArray(data.results) || data.results.length === 0) {
            const error = new Error(`Unexpected API response code ${data.response_code}`);
            error.userMessage = data.response_code === 1
                ? 'Not enough questions in this category. Try another one!'
                : 'Could not load questions right now. Please try again in a moment.';
            throw error;
        }

        const decode = (value) => decodeURIComponent(value ?? '');
        this.questions = data.results.map(q => {
            const correct = decode(q.correct_answer);
            return {
                question: decode(q.question),
                category: decode(q.category),
                difficulty: decode(q.difficulty).toLowerCase(),
                correctAnswer: correct,
                answers: shuffle([...q.incorrect_answers.map(decode), correct]),
            };
        });
    }

    showMessage(message, { spinner = false, backButton = false } = {}) {
        const children = [];
        if (spinner) children.push(el('span', { className: 'spinner' }));
        children.push(el('p', { text: message }));
        if (backButton) {
            const back = el('button', { className: 'btn btn-ghost', text: '← Back' });
            back.type = 'button';
            back.addEventListener('click', () => this.showStartScreen());
            children.push(back);
        }
        document.getElementById('game-area').replaceChildren(el('div', { className: 'loader' }, children));
    }

    // ---- HUD -------------------------------------------------------------

    updateScoreDisplay(animate = true) {
        document.getElementById('score-display').textContent = this.score;
        const chip = document.querySelector('.score-chip');
        chip.classList.remove('bump');
        if (animate) {
            void chip.offsetWidth; // restart the animation
            chip.classList.add('bump');
        }
    }

    renderProgress(total) {
        const progress = document.getElementById('progress');
        progress.replaceChildren(...Array.from({ length: total }, (_, i) => {
            const item = el('li');
            const result = this.results[i];
            if (result === true) item.className = 'is-correct';
            else if (result === false) item.className = 'is-wrong';
            else if (i === this.currentQuestion) item.className = 'is-current';
            item.setAttribute('aria-label', `Question ${i + 1}: ${result === true ? 'correct' : result === false ? 'wrong' : i === this.currentQuestion ? 'current' : 'upcoming'}`);
            return item;
        }));
    }

    resetTimerDisplay() {
        this.timeLeft = QUESTION_TIME;
        const ring = document.getElementById('timer-ring');
        // Jump back to full without animating the ring backwards.
        ring.style.transition = 'none';
        this.updateTimerDisplay();
        void ring.getBoundingClientRect();
        ring.style.transition = '';
    }

    startTimer() {
        this.resetTimerDisplay();
        clearInterval(this.timer);

        this.timer = setInterval(() => {
            this.timeLeft--;
            this.updateTimerDisplay();

            if (this.timeLeft <= 5 && this.timeLeft > 0) {
                playSound(this.tickSound);
            }

            if (this.timeLeft <= 0) {
                clearInterval(this.timer);
                playSound(this.timeoutSound);
                this.handleTimeUp();
            }
        }, 1000);
    }

    updateTimerDisplay() {
        document.getElementById('timer-text').textContent = this.timeLeft;
        const timer = document.getElementById('timer');
        timer.setAttribute('aria-label', `${this.timeLeft} seconds remaining`);
        timer.classList.toggle('is-low', this.timeLeft <= 10 && this.timeLeft > 5);
        timer.classList.toggle('is-critical', this.timeLeft <= 5);
        const elapsed = 1 - this.timeLeft / QUESTION_TIME;
        document.getElementById('timer-ring').style.strokeDashoffset = String(TIMER_CIRCUMFERENCE * elapsed);
    }

    // ---- Questions ---------------------------------------------------------

    renderQuestion() {
        const question = this.questions[this.currentQuestion];

        this.answerButtons = question.answers.map((answer, i) => {
            const button = el('button', { className: 'answer-btn' }, [
                el('span', { className: 'answer-letter', text: ANSWER_LETTERS[i] }),
                el('span', { className: 'answer-text', text: answer }),
            ]);
            button.type = 'button';
            button.addEventListener('click', () => this.handleAnswer(button, answer));
            return { button, answer };
        });

        const meta = el('div', { className: 'question-meta' }, [
            el('span', { text: `Question ${this.currentQuestion + 1} of ${this.questions.length}` }),
        ]);
        if (question.category) meta.appendChild(el('span', { className: 'pill', text: question.category }));
        if (['easy', 'medium', 'hard'].includes(question.difficulty)) {
            meta.appendChild(el('span', { className: `pill pill-${question.difficulty}`, text: question.difficulty }));
        }

        const hint = el('p', { className: 'keyboard-hint' });
        hint.append('Tip: press ', el('kbd', { text: '1' }), '–', el('kbd', { text: '4' }), ' or ',
            el('kbd', { text: 'A' }), '–', el('kbd', { text: 'D' }), ' to answer');

        document.getElementById('game-area').replaceChildren(
            el('div', { className: 'question-card' }, [
                meta,
                el('h2', { className: 'question', text: question.question }),
                el('div', { className: 'answers' }, this.answerButtons.map(a => a.button)),
                el('p', { className: 'feedback', text: '' }),
                ...(this.currentQuestion === 0 ? [hint] : []),
            ])
        );

        this.renderProgress(this.questions.length);
        this.startTimer();
    }

    revealAnswers(selectedButton, outcome) {
        const { correctAnswer } = this.questions[this.currentQuestion];
        this.answerButtons.forEach(({ button, answer }) => {
            button.disabled = true;
            if (answer === correctAnswer) {
                button.classList.add('correct');
            } else if (button === selectedButton) {
                button.classList.add('incorrect');
            }
        });

        const feedback = document.querySelector('.feedback');
        const messages = {
            correct: ['Correct! 🎯', 'is-correct'],
            wrong: [`Not quite. The answer was “${correctAnswer}”.`, 'is-wrong'],
            timeout: [`Time's up! The answer was “${correctAnswer}”.`, 'is-wrong'],
        };
        const [text, className] = messages[outcome];
        feedback.textContent = text;
        feedback.classList.add(className);

        this.results[this.currentQuestion] = outcome === 'correct';
        this.renderProgress(this.questions.length);
        this.advanceTimeout = setTimeout(() => this.proceedToNext(), outcome === 'correct' ? REVEAL_DELAY : REVEAL_DELAY + 700);
    }

    handleTimeUp() {
        this.revealAnswers(null, 'timeout');
    }

    handleAnswer(buttonElement, selectedAnswer) {
        clearInterval(this.timer);
        if (selectedAnswer === this.questions[this.currentQuestion].correctAnswer) {
            this.score++;
            this.updateScoreDisplay();
            playSound(this.correctSound);
            this.revealAnswers(buttonElement, 'correct');
        } else {
            playSound(this.wrongSound);
            this.revealAnswers(buttonElement, 'wrong');
        }
    }

    proceedToNext() {
        if (this.currentQuestion < this.questions.length - 1) {
            this.currentQuestion++;
            this.renderQuestion();
        } else {
            this.endGame();
        }
    }

    endGame() {
        this.stopTimers();
        this.answerButtons = [];
        this.updateHighScores();
        this.showHighScores({ showSummary: true });
    }

    // ---- High scores -------------------------------------------------------

    updateHighScores() {
        const category = this.categories.find(c => String(c.id) === this.selectedCategory);
        const highScores = this.getHighScores();
        this.lastEntryId = Date.now();
        highScores.push({
            id: this.lastEntryId,
            name: this.playerName,
            score: this.score,
            total: this.questions.length,
            category: category ? category.name : 'Any category',
            date: new Date().toLocaleDateString(),
        });

        highScores.sort((a, b) => b.score - a.score);
        try {
            localStorage.setItem(HIGH_SCORES_KEY, JSON.stringify(highScores.slice(0, 10)));
        } catch (error) {
            console.error('Could not save high scores:', error);
        }
    }

    getHighScores() {
        try {
            const parsed = JSON.parse(localStorage.getItem(HIGH_SCORES_KEY) || '[]');
            if (!Array.isArray(parsed)) return [];
            // Treat stored data as untrusted: keep only well-formed entries.
            return parsed
                .filter(s => s && typeof s === 'object' && Number.isFinite(s.score))
                .map(s => ({
                    id: Number.isFinite(s.id) ? s.id : null,
                    name: String(s.name ?? '').slice(0, MAX_NAME_LENGTH),
                    score: s.score,
                    total: Number.isFinite(s.total) ? s.total : QUESTION_COUNT,
                    category: String(s.category ?? ''),
                    date: String(s.date ?? ''),
                }));
        } catch {
            return [];
        }
    }

    clearHighScores() {
        try {
            localStorage.removeItem(HIGH_SCORES_KEY);
        } catch {
            // Storage unavailable; nothing to clear.
        }
        this.renderLeaderboard();
    }

    renderLeaderboard() {
        const highScores = this.getHighScores();
        const list = document.getElementById('high-scores-list');
        const medals = ['🥇', '🥈', '🥉'];

        if (highScores.length === 0) {
            list.replaceChildren(el('li', { className: 'empty-state', text: 'No high scores yet. Be the first!' }));
            return;
        }

        list.replaceChildren(...highScores.map((s, index) => {
            const item = el('li', { className: 'score-item' }, [
                el('span', { className: 'score-rank', text: medals[index] || String(index + 1) }),
                el('span', { className: 'score-player' }, [
                    el('span', { className: 'score-name', text: s.name }),
                    el('span', { className: 'score-meta', text: [s.category, s.date].filter(Boolean).join(' · ') }),
                ]),
                el('span', { className: 'score-value', text: `${s.score}/${s.total}` }),
            ]);
            if (s.id !== null && s.id === this.lastEntryId) item.classList.add('is-new');
            return item;
        }));
    }

    showHighScores({ showSummary }) {
        const summary = document.getElementById('result-summary');
        summary.classList.toggle('hidden', !showSummary);
        if (showSummary) {
            const total = this.questions.length;
            const { emoji, title, subtitle } = resultMessage(this.score, total);
            document.getElementById('result-emoji').textContent = emoji;
            document.getElementById('result-title').textContent = title;
            document.getElementById('result-score').textContent = `${this.score}/${total}`;
            document.getElementById('result-subtitle').textContent = `${this.playerName}, ${subtitle.charAt(0).toLowerCase()}${subtitle.slice(1)}`;
        } else {
            this.lastEntryId = null;
        }

        this.renderLeaderboard();
        this.showScreen('high-scores-screen');
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new TriviaGame();
});
