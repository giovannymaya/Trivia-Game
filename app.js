const API_BASE = 'https://opentdb.com';
const QUESTION_COUNT = 10;
const QUESTION_TIME = 30;
const MAX_NAME_LENGTH = 30;
const HIGH_SCORES_KEY = 'triviaHighScores';

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

class TriviaGame {
    constructor() {
        this.questions = [];
        this.currentQuestion = 0;
        this.score = 0;
        this.timer = null;
        this.advanceTimeout = null;
        this.timeLeft = QUESTION_TIME;
        this.playerName = '';
        this.categories = [];
        this.selectedCategory = '';
        this.sessionToken = null;

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
        select.replaceChildren(el('option', { text: 'Any Category' }));
        select.firstChild.value = '';
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

        document.getElementById('clear-scores').addEventListener('click', () => {
            if (window.confirm('Clear all high scores?')) {
                this.clearHighScores();
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

        document.getElementById('player-display').textContent = `Player: ${this.playerName}`;
        this.showScreen('game-screen');
        this.showMessage('Loading questions...');
        this.currentQuestion = 0;
        this.score = 0;

        try {
            await this.fetchQuestions();
            this.renderQuestion();
        } catch (error) {
            console.error('Error fetching questions:', error);
            this.showMessage(error.userMessage || 'Could not load questions. Please check your connection and try again.', true);
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

        const decode = (value) => decodeURIComponent(value);
        this.questions = data.results.map(q => {
            const correct = decode(q.correct_answer);
            return {
                question: decode(q.question),
                correctAnswer: correct,
                answers: shuffle([...q.incorrect_answers.map(decode), correct]),
            };
        });
    }

    showMessage(message, withBackButton = false) {
        const gameArea = document.getElementById('game-area');
        const children = [el('p', { text: message })];
        if (withBackButton) {
            const back = el('button', { className: 'restart-btn', text: 'Back' });
            back.type = 'button';
            back.addEventListener('click', () => this.showStartScreen());
            children.push(back);
        }
        gameArea.replaceChildren(el('div', { className: 'loader' }, children));
    }

    startTimer() {
        this.timeLeft = QUESTION_TIME;
        this.updateTimerDisplay();
        clearInterval(this.timer);

        this.timer = setInterval(() => {
            this.timeLeft--;
            this.updateTimerDisplay();

            if (this.timeLeft <= 5 && this.timeLeft > 0) {
                playSound(this.tickSound);
                document.getElementById('timer-fill').classList.add('time-warning');
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
        document.getElementById('timer-fill').style.width = `${(this.timeLeft / QUESTION_TIME) * 100}%`;
    }

    revealAnswers(selectedButton = null) {
        const { correctAnswer } = this.questions[this.currentQuestion];
        document.querySelectorAll('.answer-btn').forEach(btn => {
            btn.disabled = true;
            if (btn.textContent === correctAnswer) {
                btn.classList.add('correct');
            } else if (btn === selectedButton) {
                btn.classList.add('incorrect');
            }
        });
        this.advanceTimeout = setTimeout(() => this.proceedToNext(), 1500);
    }

    handleTimeUp() {
        this.revealAnswers();
    }

    renderQuestion() {
        const question = this.questions[this.currentQuestion];

        const answerButtons = question.answers.map(answer => {
            const button = el('button', { className: 'answer-btn', text: answer });
            button.type = 'button';
            button.addEventListener('click', () => this.handleAnswer(button, answer));
            return button;
        });

        document.getElementById('game-area').replaceChildren(
            el('div', { className: 'score-section' }, [
                el('p', { text: `Question ${this.currentQuestion + 1} of ${this.questions.length}` }),
                el('p', { text: `Score: ${this.score}` }),
            ]),
            el('div', { className: 'question', text: question.question }),
            el('div', { className: 'answers' }, answerButtons),
        );

        document.getElementById('timer-fill').classList.remove('time-warning');
        this.startTimer();
    }

    handleAnswer(buttonElement, selectedAnswer) {
        clearInterval(this.timer);
        if (selectedAnswer === this.questions[this.currentQuestion].correctAnswer) {
            this.score++;
            playSound(this.correctSound);
        } else {
            playSound(this.wrongSound);
        }
        this.revealAnswers(buttonElement);
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
        this.updateHighScores();
        this.showHighScores();
    }

    updateHighScores() {
        const category = this.categories.find(c => String(c.id) === this.selectedCategory);
        const highScores = this.getHighScores();
        highScores.push({
            name: this.playerName,
            score: this.score,
            total: this.questions.length,
            category: category ? category.name : 'Any Category',
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
        this.showHighScores();
    }

    showHighScores() {
        const highScores = this.getHighScores();
        const list = document.getElementById('high-scores-list');

        if (highScores.length === 0) {
            list.replaceChildren(el('p', { text: 'No high scores yet!' }));
        } else {
            list.replaceChildren(...highScores.map((s, index) =>
                el('div', { className: 'score-item' }, [
                    el('span', { text: `${index + 1}. ${s.name}` }),
                    el('span', { text: `${s.score}/${s.total} - ${s.category}` }),
                    el('span', { text: s.date }),
                ])
            ));
        }

        this.showScreen('high-scores-screen');
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new TriviaGame();
});
